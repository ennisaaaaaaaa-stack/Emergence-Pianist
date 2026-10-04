#!/usr/bin/env bash
# install-conductor — conductor + shell 常驻化安装（幂等，可反复跑）。
# 步骤：写 env（/etc/pianist/conductor.env，600，key 从当前环境取，不落 repo）
#      → copy unit 到 /etc/systemd/system/（conductor + shell 两件）
#      → 拆异名同源残骸（§1 事故防复辟：ExecStart 指向本 repo 的 conductor.mjs/shell.mjs
#        的其它 unit 一律 disable——不 stop，残骸 cgroup 里可能有活 session，§3 误伤的形状）
#      → daemon-reload → enable+restart。
#      enable+restart 而非 enable --now：--now 只在「未运行」时启动，unit 更新后
#      已运行的服务会静默用旧配置——restart 保证装的即是跑的（幂等语义更正）。
#      shell 换防：同名 transient unit（/run/systemd/transient/…，wander 止血遗留）在跑时
#      先 stop 它再 enable+restart 正典——壳离线窗口 ≤2s，遥测按设计丢弃且出声，不静默。
# 用法：bash deploy/install-conductor.sh [--dry-run]
#   --dry-run：只打印将做什么，不动系统（只读查询除外）。
# 测试/演练覆写（不动真系统的旁路）：CONDUCTOR_ENV_FILE / CONDUCTOR_UNIT_DEST /
#   CONDUCTOR_SYSTEMCTL / CONDUCTOR_NODE_BIN——指到 tmp 即整装进沙盒。
set -euo pipefail

DRY=0
[[ "${1:-}" == "--dry-run" ]] && DRY=1

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_SRC="$REPO_ROOT/deploy/pianist-conductor.service"
SHELL_UNIT_SRC="$REPO_ROOT/deploy/pianist-shell.service"
ENV_FILE="${CONDUCTOR_ENV_FILE:-/etc/pianist/conductor.env}"
UNIT_DEST_DIR="${CONDUCTOR_UNIT_DEST:-/etc/systemd/system}"
UNIT_DEST="$UNIT_DEST_DIR/pianist-conductor.service"
SHELL_UNIT_DEST="$UNIT_DEST_DIR/pianist-shell.service"
CGROUP_FILE="${CONDUCTOR_CGROUP_FILE:-/proc/self/cgroup}" # 测试/演练可指夹具（自保判据同源）
NODE_BIN="${CONDUCTOR_NODE_BIN:-$(command -v node)}"
SYSTEMCTL="${CONDUCTOR_SYSTEMCTL:-systemctl}"

say() { echo "[install-conductor] $*"; }
die() { echo "[install-conductor] 失败（不静默）：$*" >&2; exit 1; }
run() { # run <cmd>... —— dry-run 只打印，真跑执行
	if (( DRY )); then say "[dry-run] $*"; else "$@"; fi
}

# ---- node 版本钉（engines>=22 同源）：部署 shell 的 PATH 可能解析到系统 node20——
# 落进 unit 的就是它，版本错位结构性复现（19连抽钉子钉了爹漏了儿子的安装器这半）。
# 解析出的 node 不达 >=22 → 大声死，明示用 CONDUCTOR_NODE_BIN 指正典。
NODE_MAJOR="$("$NODE_BIN" --version 2>/dev/null | grep -oE "v[0-9]+" | tr -d v | head -1)"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge 22 ]] || die "node 版本不达 >=22：$NODE_BIN（解析得 ${NODE_MAJOR:-无}）——engines 契约挡门。正例：CONDUCTOR_NODE_BIN=<your-node-22-path> bash deploy/install-conductor.sh"

# ---- 前置体检：缺一样就大声死，不装哑巴 ----
[[ -f "$UNIT_SRC" ]] || die "unit 源不存在：$UNIT_SRC"
[[ -f "$SHELL_UNIT_SRC" ]] || die "shell unit 源不存在：$SHELL_UNIT_SRC（正典壳 unit——§2 遥测黑洞的根治件）"
[[ -x "$NODE_BIN" ]] || die "node 不可执行：$NODE_BIN（unit ExecStart 钉的就是它）"
[[ -f "$REPO_ROOT/src/conductor.mjs" ]] || die "conductor.mjs 不存在：$REPO_ROOT/src/conductor.mjs"

# ---- 钥匙柜探测（T15 活一）：key 供给三态 ----
#   柜有 coding-plan → 柜供（conductor 启动时自读，env 文件不再写 key 行——明文残留面就此收口）
#   柜无 + 当前 env 有 → 过渡态：照旧写 env 文件（否则服务起不来），但出声点名这是残留
#   双无 → 大声死（原来就这样）
CRED_STORE="$REPO_ROOT/credentials/store.mjs"
if [[ -f "$CRED_STORE" ]] && "$NODE_BIN" "$CRED_STORE" has coding-plan 2>/dev/null | grep -q '^true$'; then
	KEY_FROM_VAULT=1
elif [[ -z "${ZAI_CODING_CN_API_KEY:-}" ]]; then
	die "钥匙柜里没有 coding-plan，且当前环境没有 ZAI_CODING_CN_API_KEY——两条路都断（不静默）"
else
	KEY_FROM_VAULT=0
	say "过渡态：钥匙柜里没有 coding-plan，key 继续走 env 文件明文（残留面——放钥匙进柜后重跑本脚本即可收口）"
fi

say "repo=$REPO_ROOT node=$NODE_BIN"
say "unit: $UNIT_SRC -> $UNIT_DEST"
say "unit: $SHELL_UNIT_SRC -> $SHELL_UNIT_DEST"
say "env : $ENV_FILE（600，repo 外不进 git）"

# ---- 1. env 文件（幂等：每次按当前环境重写；预算行保全）----
# 预算钉（2026-09-26 wander）：CONDUCTOR_DAILY_BUDGET 落在 env 文件里（the user 2026-09-26 拍板
# 2→20 元）——重写若只写 key 行，拍过的板就静默蒸发回默认 2。取值优先级：当前 env >
# 既有文件行 > 不写（conductor 内建默认）。
BUDGET_LINE=""
if [[ -n "${CONDUCTOR_DAILY_BUDGET:-}" ]]; then
	BUDGET_LINE="CONDUCTOR_DAILY_BUDGET=$CONDUCTOR_DAILY_BUDGET"
elif [[ -f "$ENV_FILE" ]] && grep -q '^CONDUCTOR_DAILY_BUDGET=' "$ENV_FILE" 2>/dev/null; then
	BUDGET_LINE="$(grep '^CONDUCTOR_DAILY_BUDGET=' "$ENV_FILE")"
	say "env 重写保全既有预算行：$BUDGET_LINE（当前环境未带，文件里有——拍过板的账不因重装蒸发）"
fi
# 表名缝（2026-09-29 wander，09-28 深夜 env-event 预取三连红验尸）：CONDUCTOR_EVENT_TABLE 指
# 远端库真表名——开源仓默认脱敏名 event-queue 在私有库不存在（病名 no such table）。同预算行
# 纪律：当前 env > 既有文件行 > 不写值只落注释行提示缝的存在——装的时候看得见，出病的时候搜得到。
TABLE_LINE=""
if [[ -n "${CONDUCTOR_EVENT_TABLE:-}" ]]; then
	TABLE_LINE="CONDUCTOR_EVENT_TABLE=$CONDUCTOR_EVENT_TABLE"
elif [[ -f "$ENV_FILE" ]] && grep -q '^CONDUCTOR_EVENT_TABLE=' "$ENV_FILE" 2>/dev/null; then
	TABLE_LINE="$(grep '^CONDUCTOR_EVENT_TABLE=' "$ENV_FILE")"
	say "env 重写保全既有表名行：$TABLE_LINE（当前环境未带，文件里有——缝不因重装蒸发）"
fi
# 通用缝保全（2026-09-30 wander，部署前体检发现）：env 重写曾只认预算/表名两行——
# fba4b11 落的 CONDUCTOR_SVPS_SSH（env-event 预取的 ssh host 缝）重装即静默蒸发。
# 同族纪律一般化：文件里任何 CONDUCTOR_* 键，当前 env 带 → 写当前值；未带 → 原行保全。
# （只保全既有键不引入新键——新缝仍走显式添加，别让 session 环境顺手漏进正册。）
EXTRA_ENV_LINES=""
if [[ -f "$ENV_FILE" ]]; then
	while IFS= read -r line; do
		key="${line%%=*}"
		[[ "$key" == "CONDUCTOR_DAILY_BUDGET" || "$key" == "CONDUCTOR_EVENT_TABLE" ]] && continue # 已按各自纪律处理
		cur="${!key:-}"
		if [[ -n "$cur" ]]; then
			EXTRA_ENV_LINES+="$key=$cur"$'\n'
		else
			EXTRA_ENV_LINES+="$line"$'\n'
			say "env 重写保全既有缝行：$line（当前环境未带，文件里有——缝不因重装蒸发）"
		fi
		done < <(grep -E '^CONDUCTOR_[A-Z0-9_]+=' "$ENV_FILE" 2>/dev/null || true)
fi
if (( KEY_FROM_VAULT )); then
	say "钥匙柜供 key（coding-plan 在柜）：env 文件不写 key 行——conductor 启动时经 credentials/env-source.mjs 自读"
fi
if (( DRY )); then
	if (( KEY_FROM_VAULT )); then
		say "[dry-run] mkdir -p $(dirname "$ENV_FILE")；写 $ENV_FILE（key 走钥匙柜，env 文件不写 key 行${BUDGET_LINE:+；$BUDGET_LINE}${TABLE_LINE:+；$TABLE_LINE}；表名缝无值时落注释行）；chmod 600"
	else
		say "[dry-run] mkdir -p $(dirname "$ENV_FILE")；写 $ENV_FILE（ZAI_CODING_CN_API_KEY=***${BUDGET_LINE:+；$BUDGET_LINE}${TABLE_LINE:+；$TABLE_LINE}；表名缝无值时落注释行）；chmod 600"
	fi
else
	mkdir -p "$(dirname "$ENV_FILE")"
	umask 177 # 创建即 600，不留 group/other 可读的中间态窗口
	{
		echo "# pianist-conductor env（install-conductor.sh 生成，勿提交勿外传——路径在 repo 外）"
		# key 行三态（T15 活一）：柜供不写（明文残留面收口）；过渡态照写（服务要能起）。
		if (( ! KEY_FROM_VAULT )); then
			echo "ZAI_CODING_CN_API_KEY=$ZAI_CODING_CN_API_KEY"
		fi
		[[ -n "$BUDGET_LINE" ]] && echo "$BUDGET_LINE" || true
		[[ -n "$TABLE_LINE" ]] && echo "$TABLE_LINE" || echo "# CONDUCTOR_EVENT_TABLE=<真表名>  # 远端库真表名（开源默认脱敏名 event-queue 撞 no such table 时解此）"
		[[ -n "$EXTRA_ENV_LINES" ]] && printf '%s' "$EXTRA_ENV_LINES" || true
	} > "$ENV_FILE"
	chmod 600 "$ENV_FILE"
fi

# ---- 3. 异名同源残骸拆除（disable 不 stop——§3 钉子：残骸 cgroup 里可能有活 session）----
# 判据：unit 文件 ExecStart 指向本 repo 的 src/conductor.mjs 或 src/shell.mjs，且不是正典两个名字。
# 实害记忆：2026-09-26 §1——portalk-conductor 与 pianist-conductor 同时 enabled，重启后双跑
# 抽卡 ×2 + state.json 互覆。disable 让它重启不复活；运行时退场谁在场谁处置（残骸清道夫先例）。
for f in "$UNIT_DEST_DIR"/*.service; do
	[[ -f "$f" ]] || continue
	base="$(basename "$f")"
	[[ "$base" == "pianist-conductor.service" || "$base" == "pianist-shell.service" ]] && continue
	if grep -Eq "^ExecStart=.*$REPO_ROOT/src/(conductor|shell)\.mjs" "$f" 2>/dev/null; then
		say "残骸发现：$base 的 ExecStart 指向本 repo 同源进程——disable（不 stop：里面可能有活 session，重启不复活即达）"
		run "$SYSTEMCTL" disable "$base"
	fi
done

# ---- 4. unit 生效 ----
run mkdir -p "$UNIT_DEST_DIR" # 真路径 /etc/systemd/system 本就存在；旁路/异机部署不依赖这个假设
# 模板展开落地：__REPO_HOME__/__NODE_BIN__ 替换为部署值（dry-run 只打印计划）
expand_unit() { # expand_unit <src> <dest>
	if (( DRY )); then
		say "[dry-run] sed -e s|__REPO_HOME__|$REPO_ROOT|g -e s|__NODE_BIN__|$NODE_BIN|g $1 > $2"
	else
		sed -e "s|__REPO_HOME__|$REPO_ROOT|g" -e "s|__NODE_BIN__|$NODE_BIN|g" "$1" > "$2"
	fi
}
expand_unit "$UNIT_SRC" "$UNIT_DEST"
expand_unit "$SHELL_UNIT_SRC" "$SHELL_UNIT_DEST"

# ---- 5. shell 换防：transient 止血 unit → 正典（只读查询照跑，动作用的走 run）----
# 同名 transient（FragmentPath 在 /run/systemd/transient/）与正典不能并存——先停前者。
# 离线窗口 ≤2s：遥测 ingest 失败即丢（设计行为），丢弃必出声——短暂的疼换重启永生。
if "$SYSTEMCTL" is-active --quiet pianist-shell 2>/dev/null; then
	FRAG="$($SYSTEMCTL show pianist-shell -p FragmentPath --value 2>/dev/null || true)"
	if [[ "$FRAG" == /run/systemd/transient/* ]]; then
		say "换防：pianist-shell 是 transient unit（$FRAG）——stop 它再拉正典（壳离线 ≤2s）"
		run "$SYSTEMCTL" stop pianist-shell
	fi
fi
run "$SYSTEMCTL" daemon-reload
run "$SYSTEMCTL" enable pianist-conductor
# ---- 自保钉（§1/§3 同源）：安装者若活在 conductor 自己的 cgroup 里，restart=自杀 ----
# （conductor 拉起的 session 都在它 cgroup 里——补刀得等值班者退役后。）改出声推迟：
# unit/env 已落位，重启延后（宿主机下次重启自然生效；或值班者收尾时补刀——先例：残骸清道夫）。
OWN_UNIT="$(grep -oE '/[A-Za-z0-9@:_.-]+\.service' "$CGROUP_FILE" 2>/dev/null | head -1 | tr -d '/' || true)"
if [[ "$OWN_UNIT" == "pianist-conductor.service" ]]; then
	say "推迟 conductor 重启：安装进程活在它的 cgroup 里（own=$OWN_UNIT，§1 钉子——restart 会自杀）。unit/env 已落位，重启待宿主重启或值班者补刀——正典清道夫件：deploy/rearm-conductor.sh（systemd-run 挂它；探针是 cgroup.procs 对照 MainPID，别手搓 pgrep——pi 会把 argv 改写成 'pi'，pgrep 是瞎的）"
else
	run "$SYSTEMCTL" restart pianist-conductor
fi
run "$SYSTEMCTL" enable pianist-shell
run "$SYSTEMCTL" restart pianist-shell

if (( DRY )); then
	say "dry-run 完：以上均未执行。"
else
	say "装完。conductor=$($SYSTEMCTL is-active pianist-conductor) shell=$($SYSTEMCTL is-active pianist-shell) ｜ 查日志：journalctl -u pianist-conductor -u pianist-shell -f"
fi
