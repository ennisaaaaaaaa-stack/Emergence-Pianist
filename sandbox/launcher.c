// sandbox/launcher.c —— 轻档沙箱引导器（netns + Landlock + Seccomp + 特权降落）
// 由 executor.mjs 自动编译（gcc -O2 -o bin/sandbox-launcher launcher.c），不手跑。
// 用法：sandbox-launcher --status-fd 3 [--uid U] [--gid G] [--ro PATH]... [--rw PATH]... -- cmd [args...]
//
// 顺序铁律（不可换）：
//   unshare(CLONE_NEWNET) → lo up → Landlock 白名单 → no_new_privs → Seccomp（拒重特权）
//   → 降权 nobody → 向 status-fd 写 OK → execvp。
//   seccomp 过滤器拒 unshare/setns，所以自己的 namespace 必须在装过滤器之前开完。
// 失败出声不静默：任何一步失败都向 status-fd 写 "ERR <step>: <detail> (errno=..)" 后退场。

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/landlock.h>
#include <linux/seccomp.h>
#include <net/if.h>
#include <sched.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef LANDLOCK_ACCESS_FS_REFER
#error "需要 Landlock ABI>=2 头文件（linux-libc-dev >= 5.13，本仓基线 Ubuntu 24.04 满足）"
#endif

static int status_fd = -1;
static int ll_fd = -1;          // Landlock ruleset fd
static uint64_t rw_dir_access = 0; // 目录级 rw 权限集（按 ABI 裁剪后）

__attribute__((noreturn)) static void fail(const char *step, const char *detail) {
	char msg[512];
	snprintf(msg, sizeof(msg), "ERR %s: %s (errno=%d %s)\n", step, detail ? detail : "-", errno,
	         strerror(errno));
	if (status_fd >= 0) dprintf(status_fd, "%s", msg);
	fputs(msg, stderr); // 出声纪律：状态管道之外 stderr 也留一份，不静默退场
	_exit(126);
}

/** 给一条 Landlock 规则：path 下 rw=0 给 读+执行，rw=1 给读写（目录）或读写（单文件） */
static void ll_allow(const char *path, int rw) {
	errno = 0;
	int pfd = open(path, O_PATH | O_CLOEXEC);
	if (pfd < 0) fail("landlock-open", path);
	struct stat st;
	if (fstat(pfd, &st) < 0) fail("landlock-stat", path);
	uint64_t access;
	if (!rw)
		access = S_ISDIR(st.st_mode)
		             ? (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE |
		                LANDLOCK_ACCESS_FS_READ_DIR)
		             : (LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE);
	else
		access = S_ISDIR(st.st_mode) ? rw_dir_access
		                             : (LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE);
	struct landlock_path_beneath_attr attr = {
		.parent_fd = pfd,
		.allowed_access = access,
	};
	if (syscall(SYS_landlock_add_rule, ll_fd, LANDLOCK_RULE_PATH_BENEATH, &attr, 0) < 0)
		fail("landlock-add-rule", path);
	close(pfd);
}

static void bring_lo_up(void) {
	errno = 0;
	int s = socket(AF_INET, SOCK_DGRAM, 0);
	if (s < 0) fail("lo-up-socket", NULL);
	struct ifreq ifr;
	memset(&ifr, 0, sizeof(ifr));
	strncpy(ifr.ifr_name, "lo", IFNAMSIZ - 1);
	if (ioctl(s, SIOCGIFFLAGS, &ifr) < 0) fail("lo-up-SIOCGIFFLAGS", NULL);
	ifr.ifr_flags |= IFF_UP;
	if (ioctl(s, SIOCSIFFLAGS, &ifr) < 0) fail("lo-up-SIOCSIFFLAGS", "netns 内 lo 起不来");
	close(s);
}

/** 默认放行、只拒重特权系（任务书清单 + 同族的 kexec_file_load）。命中即 EPERM。 */
static void install_seccomp(void) {
	static const long denied[] = {
		SYS_mount,	 SYS_umount2,	SYS_kexec_load, SYS_kexec_file_load,
		SYS_reboot,	 SYS_swapon,	SYS_swapoff,	SYS_ptrace,
		SYS_bpf,	 SYS_init_module, SYS_finit_module, SYS_delete_module,
		SYS_setns,	 SYS_unshare,
	};
	const size_t n = sizeof(denied) / sizeof(denied[0]);
	struct sock_filter *f = calloc(4 + 2 * n + 1, sizeof(*f));
	if (!f) fail("seccomp-alloc", NULL);
	size_t i = 0;
	// 架构门：非 x86_64 一律 EPERM（本仓只跑 x86_64，其余架构视为异常出声）
	f[i++] = (struct sock_filter){BPF_LD | BPF_W | BPF_ABS, 0, 0, 4}; // seccomp_data.arch
	f[i++] = (struct sock_filter){BPF_JMP | BPF_JEQ | BPF_K, 1, 0, AUDIT_ARCH_X86_64};
	f[i++] = (struct sock_filter){BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)};
	f[i++] = (struct sock_filter){BPF_LD | BPF_W | BPF_ABS, 0, 0, 0}; // seccomp_data.nr
	for (size_t k = 0; k < n; k++) {
		f[i++] = (struct sock_filter){BPF_JMP | BPF_JEQ | BPF_K, 0, 1, (uint32_t)denied[k]};
		f[i++] = (struct sock_filter){BPF_RET | BPF_K, 0, 0,
		                              SECCOMP_RET_ERRNO | (EPERM & SECCOMP_RET_DATA)};
	}
	f[i++] = (struct sock_filter){BPF_RET | BPF_K, 0, 0, SECCOMP_RET_ALLOW};
	struct sock_fprog prog = {.len = (unsigned short)i, .filter = f};
	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) fail("no-new-privs", NULL);
	if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) < 0) fail("seccomp-install", NULL);
	free(f);
}

int main(int argc, char **argv) {
	uid_t uid = 65534; // nobody —— 特权降落（T9 范围文档§四：非 root）
	gid_t gid = 65534;
	const char *ro[64];
	const char *rw[64];
	int nro = 0, nrw = 0;
	int cmdi = argc;

	for (int i = 1; i < argc; i++) {
		if (!strcmp(argv[i], "--status-fd") && i + 1 < argc)
			status_fd = atoi(argv[++i]);
		else if (!strcmp(argv[i], "--uid") && i + 1 < argc)
			uid = (uid_t)atoi(argv[++i]);
		else if (!strcmp(argv[i], "--gid") && i + 1 < argc)
			gid = (gid_t)atoi(argv[++i]);
		else if (!strcmp(argv[i], "--ro") && i + 1 < argc)
			ro[nro++] = argv[++i];
		else if (!strcmp(argv[i], "--rw") && i + 1 < argc)
			rw[nrw++] = argv[++i];
		else if (!strcmp(argv[i], "--"))
			{ cmdi = i + 1; break; }
		else {
			fprintf(stderr, "sandbox-launcher: 未知参数 %s\n", argv[i]);
			return 2;
		}
	}
	if (cmdi >= argc || status_fd < 0) {
		fprintf(stderr,
		        "用法: sandbox-launcher --status-fd N [--uid U] [--gid G] [--ro P]... [--rw P]... -- cmd...\n");
		return 2;
	}
	fcntl(status_fd, F_SETFD, FD_CLOEXEC);

	// ① 独立 netns（在 seccomp 之前——过滤器拒 unshare/setns，自己要用的先开完）
	errno = 0;
	if (unshare(CLONE_NEWNET) < 0)
		fail("unshare-CLONE_NEWNET", "独立 netns 建立失败（需 root/CAP_SYS_ADMIN）");
	bring_lo_up();

	// ② Landlock 文件白名单：清单内放行，清单外（含 /mnt、/home、/proc/sys、/sys、/root 未放行处）物理不可达
	errno = 0;
	int abi = syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
	if (abi < 1) fail("landlock-abi", "本机内核不支持 Landlock（需 >= 5.13）");
	uint64_t handled = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_WRITE_FILE |
	                   LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR |
	                   LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE |
	                   LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_DIR |
	                   LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_SOCK |
	                   LANDLOCK_ACCESS_FS_MAKE_FIFO | LANDLOCK_ACCESS_FS_MAKE_BLOCK |
	                   LANDLOCK_ACCESS_FS_MAKE_SYM;
	if (abi >= 2) handled |= LANDLOCK_ACCESS_FS_REFER;
	if (abi >= 3) handled |= LANDLOCK_ACCESS_FS_TRUNCATE;
	rw_dir_access = handled & ~(LANDLOCK_ACCESS_FS_MAKE_CHAR | LANDLOCK_ACCESS_FS_MAKE_BLOCK);
	struct landlock_ruleset_attr rs = {.handled_access_fs = handled};
	int ll_ruleset_fd = syscall(SYS_landlock_create_ruleset, &rs, sizeof(rs), 0);
	if (ll_ruleset_fd < 0) fail("landlock-create-ruleset", NULL);
	ll_fd = ll_ruleset_fd;
	for (int k = 0; k < nro; k++) ll_allow(ro[k], 0);
	for (int k = 0; k < nrw; k++) ll_allow(rw[k], 1);
	if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0) fail("no-new-privs", NULL);
	if (syscall(SYS_landlock_restrict_self, ll_ruleset_fd, 0) < 0) fail("landlock-restrict-self", NULL);
	close(ll_ruleset_fd);

	// ③ Seccomp：默认放行常用全集，只拒重特权系
	install_seccomp();

	// ④ 特权降落 nobody（放最后：前面每步都可能要 root）
	errno = 0;
	if (setgroups(0, NULL) < 0) fail("setgroups", NULL);
	if (setresgid(gid, gid, gid) < 0) fail("setresgid", NULL);
	if (setresuid(uid, uid, uid) < 0) fail("setresuid", NULL);
	if (getuid() != uid || geteuid() != uid) fail("verify-uid", "降权未生效");

	// ⑤ 报平安后交接
	dprintf(status_fd, "OK\n");
	execvp(argv[cmdi], &argv[cmdi]);
	fail("exec", argv[cmdi]);
}
