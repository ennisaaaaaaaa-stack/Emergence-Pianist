#!/bin/sh
# rearm-conductor — 换防清道夫（正典件）：等值班 session 退役后补刀 restart conductor。
#
# 何时用：conductor 代码/unit/env 刚落新，但安装者活在 conductor 的 cgroup 里
# （restart=自杀——install-conductor.sh 自保钉会出声推迟重启）。挂本件在系统里，
# 它替你等退役窗口再补刀。09-26 残骸清理 / 09-28 换防 / 09-29 误杀事故同一形状。
#
# 怎么挂（别在 session 里裸跑——裸跑随 session 死，就没人补刀了）：
#   systemd-run --unit=pianist-conductor-rearm --collect \
#     -p Description="rearm: wait sessions retire, then restart pianist-conductor" \
#     /bin/sh /path/to/repo/deploy/rearm-conductor.sh
#
# 探针纪律（2026-09-29 wander 验尸钉死，别再退回 pgrep）：
#   判「cgroup 里还有没有活 session」只能读 cgroup.procs 对照 systemctl MainPID。
#   pi 启动后会把 argv 整个改写成 'pi'（/proc/<pid>/cmdline 只剩两个字母）——
#   pgrep -f 'cli\.js -p' 之类永远匹配不到任何活 session。09-29 00:28 的手搓盲清道夫
#   就这么在「20s 确认窗」里全瞎两读，把正写收尾报告的 wander 杀了（报告/遥测尾批/
#   launch 记录三失）。判据只会晚收不会误收：任何读数异常一律按「忙」处理。
#
# 测试缝（test/rearm-conductor-test.mjs 用，不动真系统）：
#   REARM_UNIT / REARM_CGROUP_PROCS / REARM_SYSTEMCTL / REARM_CONFIRM_SECS /
#   REARM_POLL_SECS / REARM_TOTAL_SECS。
set -u

UNIT="${REARM_UNIT:-pianist-conductor}"
CGROUP_PROCS="${REARM_CGROUP_PROCS:-/sys/fs/cgroup/system.slice/${UNIT}.service/cgroup.procs}"
SYSTEMCTL="${REARM_SYSTEMCTL:-systemctl}"
CONFIRM_SECS="${REARM_CONFIRM_SECS:-20}"   # 判闲后确认窗：隔这么久再读一次还是闲才算数
POLL_SECS="${REARM_POLL_SECS:-10}"         # 忙时轮询周期
TOTAL_SECS="${REARM_TOTAL_SECS:-7200}"     # 总超时：自灭退场，新代码等宿主下次重启自然上膛

say() { echo "[rearm] $*"; }

# 判闲：cgroup.procs 可读，且去掉 MainPID 后没有别的 PID（空文件也算闲——unit 没进程）。
# 读不到文件 / systemctl 问不出 MainPID → 一律按忙（晚收不误收，绝不猜）。
is_idle() {
	[ -r "$CGROUP_PROCS" ] || return 1
	MAIN="$("$SYSTEMCTL" show "$UNIT" -p MainPID --value 2>/dev/null)" || return 1
	[ -n "$MAIN" ] || MAIN=0
	for p in $(cat "$CGROUP_PROCS" 2>/dev/null); do
		[ "$p" = "$MAIN" ] || return 1
	done
	return 0
}

say "上岗：等 $UNIT 的 cgroup 只剩主进程（确认窗 ${CONFIRM_SECS}s 两读，总超时 ${TOTAL_SECS}s）后补刀 restart"
elapsed=0
streak=0
state="startup"
while [ "$elapsed" -lt "$TOTAL_SECS" ]; do
	if is_idle; then
		streak=$((streak + 1))
		if [ "$state" != "idle" ]; then
			say "cgroup 判闲——进确认窗（还需隔 ${CONFIRM_SECS}s 再读一次闲才动手）"
			state="idle"
		fi
		if [ "$streak" -ge 2 ]; then
			say "确认窗过了：cgroup 连续两读只剩主进程——补刀 restart $UNIT"
			if "$SYSTEMCTL" restart "$UNIT"; then
				say "restart 完成，清道夫退场"
				exit 0
			else
				say "restart 失败（不静默）——清道夫退场，留给宿主重启或人工"
				exit 1
			fi
		fi
		sleep "$CONFIRM_SECS"
		elapsed=$((elapsed + CONFIRM_SECS))
	else
		if [ "$state" != "busy" ]; then
			say "cgroup 还有值班进程——继续等（不误收）"
			state="busy"
		fi
		streak=0
		sleep "$POLL_SECS"
		elapsed=$((elapsed + POLL_SECS))
	fi
done
say "总超时 ${TOTAL_SECS}s 自灭——没人补刀了，新代码等宿主下次重启自然上膛"
exit 1
