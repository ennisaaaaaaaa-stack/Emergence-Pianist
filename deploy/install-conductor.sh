#!/usr/bin/env bash
# install-conductor — conductor 常驻化安装（幂等，可反复跑）。
# 步骤：写 env（/etc/pianist/conductor.env，600，key 从当前环境取，不落 repo）
#      → copy unit 到 /etc/systemd/system/ → daemon-reload → enable+restart。
#      enable+restart 而非 enable --now：--now 只在「未运行」时启动，unit 更新后
#      已运行的服务会静默用旧配置——restart 保证装的即是跑的（幂等语义更正）。
# 用法：bash deploy/install-conductor.sh [--dry-run]
#   --dry-run：只打印将做什么，不动系统。
# 测试/演练覆写（不动真系统的旁路）：CONDUCTOR_ENV_FILE / CONDUCTOR_UNIT_DEST /
#   CONDUCTOR_SYSTEMCTL / CONDUCTOR_NODE_BIN——指到 tmp 即整装进沙盒。
set -euo pipefail

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$REPO_ROOT/deploy/pianist-conductor.service"
ENV_FILE="${CONDUCTOR_ENV_FILE:-/etc/pianist/conductor.env}"
UNIT_DEST_DIR="${CONDUCTOR_UNIT_DEST:-/etc/systemd/system}"
UNIT_DEST="$UNIT_DEST_DIR/pianist-conductor.service"
NODE_BIN="${CONDUCTOR_NODE_BIN:-NODE_BIN}"
SYSTEMCTL="${CONDUCTOR_SYSTEMCTL:-systemctl}"

say() { echo "[install-conductor] $*"; }
die() { echo "[install-conductor] 失败（不静默）：$*" >&2; exit 1; }
run() { # run <cmd>... —— dry-run 只打印，真跑执行
	if (( DRY )); then say "[dry-run] $*"; else "$@"; fi
}

# ---- 前置体检：缺一样就大声死，不装哑巴 ----
[[ -f "$UNIT_SRC" ]] || die "unit 源不存在：$UNIT_SRC"
[[ -x "$NODE_BIN" ]] || die "node 不可执行：$NODE_BIN（unit ExecStart 钉的就是它）"
[[ -f "$REPO_ROOT/src/conductor.mjs" ]] || die "conductor.mjs 不存在：$REPO_ROOT/src/conductor.mjs"
[[ -n "${ZAI_CODING_CN_API_KEY:-}" ]] || die "当前环境没有 ZAI_CODING_CN_API_KEY——key 只从环境取，不给默认值不落 repo"

say "repo=$REPO_ROOT node=$NODE_BIN"
say "unit: $UNIT_SRC -> $UNIT_DEST"
say "env : $ENV_FILE（600，repo 外不进 git）"

# ---- 1. env 文件（幂等：每次按当前环境重写） ----
if (( DRY )); then
	say "[dry-run] mkdir -p $(dirname "$ENV_FILE")；写 $ENV_FILE（ZAI_CODING_CN_API_KEY=***）；chmod 600"
else
	mkdir -p "$(dirname "$ENV_FILE")"
	umask 177 # 创建即 600，不留 group/other 可读的中间态窗口
	{
		echo "# pianist-conductor env（install-conductor.sh 生成，勿提交勿外传——路径在 repo 外）"
		echo "ZAI_CODING_CN_API_KEY=$ZAI_CODING_CN_API_KEY"
	} > "$ENV_FILE"
	chmod 600 "$ENV_FILE"
fi

# ---- 2. unit 生效 ----
run mkdir -p "$UNIT_DEST_DIR" # 真路径 /etc/systemd/system 本就存在；旁路/异机部署不依赖这个假设
run cp "$UNIT_SRC" "$UNIT_DEST"
run "$SYSTEMCTL" daemon-reload
run "$SYSTEMCTL" enable pianist-conductor
run "$SYSTEMCTL" restart pianist-conductor

if (( DRY )); then
	say "dry-run 完：以上均未执行。"
else
	say "装完。active=$("$SYSTEMCTL" is-active pianist-conductor) ｜ 查日志：journalctl -u pianist-conductor -f"
fi
