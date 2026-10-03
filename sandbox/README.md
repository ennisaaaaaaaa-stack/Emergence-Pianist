# sandbox/ 轻档沙箱引擎（Landlock + Seccomp + netns）

用法：`node sandbox/run-sandboxed.mjs --policy sandbox/policies/default.policy.json -- <命令...>`（需 root；引导器 launcher.c 首次自动 gcc 编译）。
三件套：Landlock 文件白名单（读系统 ro、/tmp+workspace rw、清单外——含 /mnt/c——物理不可达）+ Seccomp 拒重特权 syscall（mount/kexec/bpf/setns/unshare...一律 EPERM）+ 独立 netns（内只有 lo，出网全走 127.0.0.1:8788 → unix socket → 沙箱外白名单门禁代理 gate-proxy.mjs，沙箱内 netns-relay.mjs 接线）。
安全模型：这是门禁不是囚室——白名单开箱宽，硬拒的只有真泄密通道（RFC1918 内网/环回/链路本地/裸 IP 直连），白名单外新端点先通后报（放行本次 + 首次落 data/sandbox-journal.jsonl，字段 ts/agent/host/scope/note）。
策略文件（JSON，自带 `_schema` 自描述）：`network.allowDomains` 放行域（精确或后缀匹配）、`network.hardDeny.{cidrs,bareIp}` 硬拒、`network.proxyPort` 门禁端口、`filesystem.readOnly/readWrite/readWriteFiles` Landlock 三清单、`scratchDirPattern` 暂存目录（`<pid>` 占位）。改策略=改门禁面，加白名单条目时 commit message 记「本条新放行 X」。
身份结构位：`identity.{agent,keypair,sig}`——工牌起步即用（记账 agent），钥匙/章位预留不实现（第三方 agent 入住时启用）。
