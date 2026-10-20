# t16-audit 取证明细（audit-trail）

pianist：t16-audit-worker pianist-1 ｜ 2026-10-17 01:57–02:0x JST ｜ 全程只读（src/、桌面、档案房零写入；唯一写区=data/t16-audit/）

## A. 桌面 EP 文档族（<user-home>/Desktop/Portalk设计文档/Emergence-Pianist/）

| # | 文件 | 行数 | 读法 | 时间 |
|---|---|---|---|---|
| A1 | EP-自学习双闭环.md | 212 | 全文 | 01:58 |
| A2 | EP-Orchestrator.md | 316 | 全文 | 01:58 |
| A3 | EP-自学习闭环v2提案.md | 133 | 全文 | 01:59 |
| A4 | EP-契约-skill生命周期.md | 160 | 全文 | 01:59 |
| A5 | EP-architecture-v2.md | 432 | 全文 | 02:00 |
| A6 | EP-分身记忆三件套蓝图.md | 102 | 全文 | 02:00 |
| A7 | EP-自主探索闭环.md | 66 | 全文 | 02:00 |
| A8 | EP-自学习发现路自审材料-v1.md | 60 | 全文 | 02:01 |
| A9 | README-索引.md | 31 | 全文 | 02:01 |
| A10 | 沙箱研究/（目录） | — | 仅列名未入档 | 01:57 |

## B. spoor 档案链（/root/Stigmergy/archive/，只读）

| # | 文件 | 读法 | 时间 |
|---|---|---|---|
| B1 | portalk-selflearning-loop/76b28732447b.md（v3，46行） | 全文 | 01:59 |
| B2 | shanhai-auto-parity-doc/9fbea72a2633.md | 全文 | 01:59 |
| B3 | orchestrator-split-spec/e65d332d211a.md | 全文 | 02:00 |
| B4 | spoor-facts-table-spec/81695f8a0f06.md（v1） | 全文 | 02:00 |
| B5 | portalk-sandbox-structure/ff4c901a2005.md | 头20行 | 02:01 |
| B6 | portalk-telemetry-v1/ab4948632e86.md | 头15行 | 02:01 |
| B7 | portalk-selflearning-loop/fed71e93864c.md（九洞收口） | 头20行 | 02:01 |
| B8 | portalk-selflearning-loop/{5397dbd28d63,8006ee0bbdcf,87890b80b4a8}.md | 头8行（版序定位） | 01:59 |
| B9 | portalk-runtime-dependency-map/ 全5版 | 头3行（版序定位；v2 定型版=bca7fbb352dc 全文级抽读） | 02:01 |
| B10 | portalk-contract-skill-lifecycle/{4aa628d1595e,b575c8a0e3ff}.md | 头4行（与 A4 对照，b575c8a0e3ff≈A4 v0.2 同文） | 02:01 |
| B11 | spoor-facts-table-spec/fbf83d3e84cf.md（v2） | 尾8行 | 02:01 |
| B12 | /root/Stigmergy/workbench/portalk/STATUS.md:26 + journal/2026-10-17.md:7 | grep 定位行 | 02:01 |

## C. repo 实况（/root/portalk-runtime/，只读）

| # | 对象 | 证据点 | 时间 |
|---|---|---|---|
| C1 | git log --oneline（186 commit，dea3b78→410bb2f） | 全史扫描+六区关键词过滤 | 01:57 |
| C2 | src/retropad.mjs | :81 TIMEOUT=240 / :111 MAX_PER_RUN=10 / :483 `if (!failed) writeRetroState` / :234,236-239 健康问+tickets / :377 健康问占位 | 01:58 |
| C3 | src/l0-spine.ts | 全文305行：:46-48 阈值三元组 / bridgeToNewSession / builtinMinimalDistill | 01:58 |
| C4 | grep coverage\|T_r\|T2b src/ extensions/ | 空（零命中） | 01:58 |
| C5 | src/orchestrator/ 全目录 wc + retro-trigger.mjs:175-200 | createSessionEndHook 在 :187；全仓 grep 消费方=零 | 01:58 |
| C6 | src/skill-gate.mjs | :20-24 auto/ 前缀 / :50-99 四道闸（闸三=判而不剪 N≥5 打回） | 01:58 |
| C7 | tools/promotion-scanner.mjs 头注 | 只报告不动手/use 层判据 | 01:58 |
| C8 | src/shell.mjs :255-257,364,373 | 钉二分流 /skill/auto + 403 圈死 | 01:58 |
| C9 | src/orchestrator/casting-sheet.mjs :43-44 | 「模型:」「审链:」两列 | 01:58 |
| C10 | src/orchestrator/runtime.mjs :42,111,150,177-230 | completionPump 审链自动发车 | 01:58 |
| C11 | src/orchestrator/watchman.mjs 头注 | 三判/不入账/不杀进程 | 01:58 |
| C12 | credentials/ README + store/broker/inject/mask/journal + docs/credential-vault-v2.md + t15 两份 | T11→T15→T16 三代 | 01:58 |
| C13 | git log --all grep T11/T15/T16 | 0c44c84 / 543b853+9b08d0c / 467884b(d482a41) | 01:58 |
| C14 | src/conductor.mjs :3,145-162,307-318,327,371-395,748,843,893-899 | env-event 消费/表名单源/本地优先/死因入账/饿死退避 | 01:58 |
| C15 | src/orchestrator/{lint,floor-summary,obituary}.mjs 头注 + grep 压缩器 | lint v0 两规则/地板/讣告三源；压缩器零命中 | 02:01 |
| C16 | extensions/pianist-tools.ts :221-317 + grep emit | wireTelemetry 四事件面在；emit 零命中 | 02:01 |
| C17 | src/sandbox.mjs 头注 | 契约四魂/容器档加固清单/microVM 判别位 throw | 02:01 |
| C18 | docs/orch-v0-real-wiring.md :15-113 | 审链三件已落+10/12 诚实账（接线缺口段） | 02:01 |
| C19 | src/orchestrator/heartbeat.mjs :55,154 | 源①滚动重扫限频/滚动锁定 | 02:01 |
| C20 | data/telemetry/ 目录 | orch-* jsonl 实存 | 01:58 |
| C21 | git branch -a + git log --all | 186 commits；a166868/55ed0b2/2cb3882/ab908f4 旧 hash 不可见（史根=410bb2f 开源化重写） | 02:02 |
| C22 | deploy/（4 文件） | grep eventlog/organ 空——D1 桥不在本 repo | 02:01 |

## 回溯路径示例（验收线：抽3条）

1. gap-list 硬缺口#1（retropad 三修）→ 文档侧 B1:31-35（76b28732447b「retropad 运行性三修」节）→ repo 侧 C2（src/retropad.mjs:81/111/483 原句可 sed -n 复核）。
2. gap-list 硬缺口#3（95k 两增量）→ 文档侧 B1:20-22（增量①②原句）→ repo 侧 C3（l0-spine.ts 全文）+C4（grep 零命中，命令可复跑）。
3. gap-list 软缺口#1（README-索引滞后）→ 文档侧 A9:「EP-自学习双闭环.md …**修订中**：shadow 砍掉改机械入库管线（2026-09-28 the user定向，提案待落）」→ repo 侧 C6+C7+C8（skill-gate/promotion-scanner/shell 钉二已落）。
