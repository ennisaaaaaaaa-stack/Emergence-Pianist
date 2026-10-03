// sandbox/executor.mjs —— 轻档沙箱执行器（内核原语三件套的编排层，跑在沙箱外、root 侧）
// 三件套缺一不可：
//   1) Landlock 文件隔离：策略 readOnly/readWrite 清单外一律拒（/mnt/c 物理不可达）
//   2) Seccomp BPF：默认放行常用 syscall，拒重特权系（mount/kexec/bpf/setns/unshare...）
//   3) 独立 netns + 白名单门禁代理：netns 内只有 lo；出网走 127.0.0.1:8788 → relay → 沙箱外
//      gate-proxy（unix socket 跨 netns），先通后报记账落 data/sandbox-journal.jsonl
// 结构位预留：身份=工牌+钥匙+章位（本铲只有工牌 agent，keypair/sig 留位不实现）。
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startGateProxy } from "./gate-proxy.mjs";
import { resolveEngine } from "./engine-registry.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const JOURNAL_PATH = path.join(REPO_ROOT, "data", "sandbox-journal.jsonl");

const SANDBOX_UID = 65534; // nobody —— 特权降落
const SANDBOX_GID = 65534;

/** 读策略并做最低限度校验（坏策略大声失败，不静默兜底） */
export function loadPolicy(policyPath) {
	const p = JSON.parse(fs.readFileSync(policyPath, "utf8"));
	const need = [
		["network.allowDomains", p?.network?.allowDomains],
		["network.proxyPort", p?.network?.proxyPort],
		["network.hardDeny.cidrs", p?.network?.hardDeny?.cidrs],
		["filesystem.readOnly", p?.filesystem?.readOnly],
		["filesystem.readWrite", p?.filesystem?.readWrite],
		["scratchDirPattern", p?.scratchDirPattern],
	];
	for (const [k, v] of need) if (v === undefined) throw new Error(`策略缺字段: ${k}（${policyPath}）`);
	return p;
}

/** node 解释器实际所在目录（本机装在 /.hermes/node） */
export function nodeLandlockRoot() {
	const real = fs.realpathSync(process.execPath);
	const bin = path.dirname(real); // .../bin
	return path.basename(bin) === "bin" ? path.dirname(bin) : bin;
}

// node 解释器硬链接农场：/.hermes 的目录权限会被外部管理动作重置（实测 o+x 被 revert 回 700），
// 沙箱内 nobody 无法穿越 /.hermes → 换用 /usr/local/portalk-node 硬链接农场（同盘零拷贝、
// inode 与源一致），路径全租 755 可穿越，Landlock /usr 规则天然覆盖。仓外动作，见报告。
const NODE_FARM = "/usr/local/portalk-node";
export function ensureSandboxNode() {
	const srcRoot = nodeLandlockRoot();
	const srcNode = path.join(srcRoot, "bin", "node");
	const farmNode = path.join(NODE_FARM, "bin", "node");
	const sameInode = () => {
		try {
			const a = fs.statSync(srcNode);
			const b = fs.statSync(farmNode);
			return a.ino === b.ino && a.dev === b.dev;
		} catch {
			return false;
		}
	};
	if (!sameInode()) {
		fs.rmSync(NODE_FARM, { recursive: true, force: true });
		try {
			execFileSync("cp", ["-aRl", srcRoot, NODE_FARM], { stdio: ["ignore", "ignore", "inherit"] });
		} catch {
			execFileSync("cp", ["-aR", srcRoot, NODE_FARM], { stdio: ["ignore", "ignore", "inherit"] }); // 跨盘降级真拷
		}
		if (!sameInode() && !fs.existsSync(farmNode)) throw new Error(`node 农场建立失败：${farmNode}`);
	}
	return { binDir: path.join(NODE_FARM, "bin"), nodeBin: farmNode };
}

/** 工作区在 REPO_HOME——nobody 需要穿越 /root（只补 o+x，不授予列举/读取；缺了就补且出声） */
function ensureRootTraversal() {
	const st = fs.statSync("/root");
	if (!(st.mode & 0o001)) {
		fs.chmodSync("/root", st.mode | 0o001);
		console.warn("[sandbox] /root 缺穿越位已补 o+x（仅穿越已知路径，不授予列举/读取；DAC+Landlock 双重把门不变）");
	}
}

/** 编译引导器（源比新二进制新才重编；失败出声） */
export function ensureLauncher() {
	const src = path.join(__dirname, "launcher.c");
	const binDir = path.join(__dirname, "bin");
	const out = path.join(binDir, "sandbox-launcher");
	fs.mkdirSync(binDir, { recursive: true });
	if (!fs.existsSync(out) || fs.statSync(src).mtimeMs > fs.statSync(out).mtimeMs) {
		execFileSync(
			"gcc",
			["-O2", "-Wall", "-Werror", "-o", out, src],
			{ stdio: ["ignore", "inherit", "inherit"] }, // 编译告警直接见人
		);
	}
	return out;
}

/**
 * 隔离执行一条任意命令。
 * @param {object} o
 * @param {string[]} o.command 完整命令（argv 数组）
 * @param {string} [o.policyPath] 策略文件（默认 default.policy.json）
 * @param {string} [o.agent] 记账工牌（默认取策略 identity.agent）
 * @param {number} [o.timeoutMs] 超时杀全组
 * @param {Record<string,string>} [o.env] 额外注入子进程的环境变量（覆盖默认）
 * @returns {Promise<{code:number|null, signal:string|null, journaledHosts:string[]}>}
 */
export async function runSandboxed({
	command,
	policyPath = path.join(__dirname, "policies", "default.policy.json"),
	agent,
	timeoutMs,
	env: extraEnv,
}) {
	if (!Array.isArray(command) || command.length === 0) throw new Error("command 不能为空");
	if (process.getuid && process.getuid() !== 0)
		throw new Error("轻档沙箱需要 root（unshare(CLONE_NEWNET)+降权）；当前非 root，不静默降级");
	const policy = loadPolicy(policyPath);
	resolveEngine(policy); // engine 字段解析：轻档放行；microvm=接口位，启用前大声拒绝（不静默降级到轻档）
	const launcher = ensureLauncher();
	const sbxNode = ensureSandboxNode();
	ensureRootTraversal();

	// ① 暂存目录（约定 /tmp/sandbox-scratch-<pid>，回合结束整体清掉）
	const scratch = policy.scratchDirPattern.replace("<pid>", String(process.pid));
	fs.rmSync(scratch, { recursive: true, force: true });
	const mkd = (p, mode = 0o755) => {
		fs.mkdirSync(p, { recursive: true, mode });
		fs.chownSync(p, SANDBOX_UID, SANDBOX_GID);
	};
	mkd(scratch);
	mkd(path.join(scratch, "tmp"));
	mkd(path.join(scratch, "npm-cache"));

	// ② 沙箱外门禁代理（unix socket 跨 netns；netns 内 lo:8788 由 relay 接线）
	const gate = startGateProxy({
		policy,
		scratchDir: scratch,
		agent: agent ?? policy.identity?.agent ?? "pianist",
		journalPath: JOURNAL_PATH,
	});
	await gate.ready;

	// ③ 组装引导参数：Landlock 清单 = 策略 ro + 策略 rw + 暂存区（node 农场在 /usr 下，已覆盖）
	const roPaths = [...new Set(policy.filesystem.readOnly)];
	const rwPaths = [...new Set([...policy.filesystem.readWrite, scratch])];
	const rwFiles = policy.filesystem.readWriteFiles ?? [];
	const proxyUrl = `http://127.0.0.1:${policy.network.proxyPort}`;
	const argv = [
		launcher,
		"--status-fd",
		"3",
		"--uid",
		String(SANDBOX_UID),
		"--gid",
		String(SANDBOX_GID),
		...roPaths.flatMap((p) => ["--ro", p]),
		...rwPaths.flatMap((p) => ["--rw", p]),
		...rwFiles.flatMap((p) => ["--rw", p]),
		"--",
		sbxNode.nodeBin,
		path.join(__dirname, "netns-relay.mjs"),
		"--gate",
		gate.socketPath,
		"--port",
		String(policy.network.proxyPort),
		"--",
		...command,
	];

	// ④ 子进程环境：干净重造（不带宿主 HOME/密钥等），代理与 HOME/TMPDIR 指进沙箱
	const env = {
		PATH: [
			sbxNode.binDir,
			"/usr/local/sbin",
			"/usr/local/bin",
			"/usr/sbin",
			"/usr/bin",
			"/sbin",
			"/bin",
		].join(":"),
		HOME: scratch,
		TMPDIR: path.join(scratch, "tmp"),
		LANG: "C.UTF-8",
		http_proxy: proxyUrl,
		https_proxy: proxyUrl,
		HTTP_PROXY: proxyUrl,
		HTTPS_PROXY: proxyUrl,
		all_proxy: proxyUrl,
		ALL_PROXY: proxyUrl,
		no_proxy: "127.0.0.1,localhost",
		NO_PROXY: "127.0.0.1,localhost",
		npm_config_proxy: proxyUrl,
		npm_config_https_proxy: proxyUrl,
		npm_config_cache: path.join(scratch, "npm-cache"),
		npm_config_update_notifier: "false",
		PORTALK_SANDBOX: "1",
		PORTALK_SANDBOX_SCRATCH: scratch,
		...extraEnv,
	};

	const child = spawn(argv[0], argv.slice(1), {
		cwd: process.cwd(),
		env,
		detached: true, // 独立进程组：超时/信号时整组收割，不留孤儿
		stdio: ["inherit", "inherit", "inherit", "pipe"], // fd3 = 引导器状态管道
	});

	const cleanup = () => {
		gate.close();
		fs.rmSync(scratch, { recursive: true, force: true });
	};

	// ⑤ 等引导器报平安（OK=三件套全部就位并已交接给 relay）
	const setup = await new Promise((resolve, reject) => {
		let got = "";
		const timer = setTimeout(() => {
			reject(new Error("沙箱引导超时（15s 无 OK/ERR）"));
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
		}, 15_000);
		const done = (fn, arg) => {
			clearTimeout(timer);
			fn(arg);
		};
		child.stdio[3].on("data", (c) => {
			got += c.toString("utf8");
			const line = got.split("\n")[0];
			if (line.startsWith("OK")) done(resolve, true);
			else if (line.startsWith("ERR")) {
				try {
					process.kill(-child.pid, "SIGKILL");
				} catch {}
				done(reject, new Error(`沙箱引导失败：${line}`));
			}
		});
		child.stdio[3].on("end", () => {
			if (!got.trim()) done(reject, new Error("引导器状态管道提前关闭且无输出"));
		});
		child.on("close", (code, signal) => {
			if (!got.trim()) done(reject, new Error(`引导器未报状态即退场 code=${code} signal=${signal}`));
		});
	});

	let killer = null;
	if (setup && timeoutMs)
		killer = setTimeout(() => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
		}, timeoutMs);

	const result = await new Promise((resolve) => {
		child.on("close", (code, signal) => resolve({ code, signal }));
	});
	if (killer) clearTimeout(killer);
	cleanup();
	return { ...result, journaledHosts: [...gate.journaledHosts] };
}
