#!/usr/bin/env bash
# start-pianist.sh — 把 pianist 连上记忆和账本服务
#
# 用法（在 WSL 终端里）：
#   bash start-pianist.sh
#
# 它做三件事：
#   1. 检查五个后台服务，缺谁拉谁（Grimoire8730 / 壳8770 / spoorpianist三实例8793-8795）
#   2. 配好环境变量（壳地址 + key + 署名）
#   3. 起交互式pianist（Pi TUI）——退出按 Ctrl+C 或输 /exit
#
# 已在跑的服务会跳过（幂等），重复跑安全。

set -u

# 可配置路径（公开版默认 $HOME，本地可用 env 覆盖）
GRIMOIRE_DIR="${GRIMOIRE_DIR:-$HOME/Agent-Grimoire}"
STIGMERGY_ROOT="${STIGMERGY_ROOT:-$HOME/the-workbench}"
SPOOR_SRC="${SPOOR_SRC:-$HOME/session-spoor}"
SPOOR_PYTHON="${SPOOR_PYTHON:-$HOME/spoor-venv/bin/python}"
RUNTIME_DIR="$(cd "$(dirname "$0")" && pwd)"

# 本机服务不走代理（.bashrc 的 http_proxy 指向 Windows 侧 Clash，会劫走 127.0.0.1 的健康检查）
export no_proxy="127.0.0.1,localhost"
export NO_PROXY="127.0.0.1,localhost"

# ---------- 1. 五个服务，缺谁拉谁 ----------

ensure_port() {  # ensure_port <端口> <描述> <启动命令...>
  local port="$1"; local desc="$2"; shift 2
  if ss -tln 2>/dev/null | grep -q ":$port "; then
    echo "✓ $desc (端口 $port) 已在跑"
  else
    echo "→ 拉起 $desc (端口 $port) ..."
    "$@" >/dev/null 2>&1 &
  fi
}

ensure_port 8730 "Grimoire" env GRIMOIRE_DB="$GRIMOIRE_DIR/grimoire.db" python3 "$GRIMOIRE_DIR/grimoire.py" 8730
ensure_port 8770 "shell"  env PIANIST_SHELL_PORT=8770 node "$RUNTIME_DIR/src/shell.mjs"

# spoor 三实例（一实例一署名：pianist）
spoor_up() {  # spoor_up <模块> <端口>
  if ! ss -tln 2>/dev/null | grep -q ":$2 "; then
    SPOOR_AGENT="${SPOOR_AGENT:-pianist}" STIGMERGY_ROOT="$STIGMERGY_ROOT" "$SPOOR_PYTHON" -c "
import sys; import os as _os; sys.path.insert(0, _os.environ["SPOOR_SRC"])
import $1 as m
m.mcp.settings.host = '127.0.0.1'; m.mcp.settings.port = $2
m.mcp.run(transport='streamable-http')
" >/dev/null 2>&1 &
    echo "→ 拉起 spoor-$1 (端口 $2)"
  else
    echo "✓ spoor-$1 (端口 $2) 已在跑"
  fi
}
spoor_up workbench_server 8793
spoor_up archive_server 8794
spoor_up scratchpad_server 8795

# 等服务就位（最长 8 秒）
for i in $(seq 1 16); do
  curl -s -m 1 http://127.0.0.1:8770/health >/dev/null 2>&1 && break
  sleep 0.5
done
if curl -s -m 2 http://127.0.0.1:8770/health | grep -q '"ok":true'; then
  echo "✓ 壳健康检查通过"
else
  echo "⚠ 壳没起来——查 /tmp/pianist-shell.log"
  exit 1
fi

# ---------- 2. 环境 ----------

export PIANIST_SHELL_URL=http://127.0.0.1:8770
export PIANIST_AGENT_ID="${PIANIST_AGENT_ID:-pianist-dev-1}"
export ZAI_CODING_CN_API_KEY="${ZAI_CODING_CN_API_KEY:?export ZAI_CODING_CN_API_KEY first}"
# ↑ key 必须从 env 供给（仓库不含任何密钥）

# ---------- 3. 起pianist ----------

echo
echo "=============================="
echo " pianist（Pi）启动——开口第一句可以试试："
echo "   「用 pianist_bridge 查一下家里的工作台有哪些项目」"
echo " 退出：输 /exit 或按两次 Ctrl+C"
echo "=============================="
echo
exec "$RUNTIME_DIR/node_modules/.bin/pi" --model zai-coding-cn/glm-5.2
