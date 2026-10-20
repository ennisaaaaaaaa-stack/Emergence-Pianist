# t16-audit 缺口清单（gap-list）

对账轴：文档声称 vs repo 实况（HEAD=dea3b78，2026-10-17）。每条双侧证据（文档侧：文件:行+原句引号；repo 侧：文件:行 或 git hash）。
已知事实段（审链 f8a1c0a 已落 / retropad 三修未落 / 源3 零调用方 / 95k 骨架在）照抄采信，本单只补行级证据，未重探。

---

## 【硬缺口·链路断的】

### H1. retropad 运行性三修：三条全未落（区e）
- 文档侧：`/root/Stigmergy/archive/portalk-selflearning-loop/76b28732447b.md:31-35`「## retropad 运行性三修（机械，当日可修）…1. 批次上限：一次盘 ≤5 热点…2. 超时按批次缩放：timeout = 180 + 60×批数 3. 死亡落账：非法收工也写 state（verdict=failed），due 源不空转」
- repo 侧：`src/retropad.mjs:111` `const MAX_PER_RUN = 10;`（v3 定案 ≤5）；`:81` `const TIMEOUT = Math.max(5, parseInt(arg("timeout", "240"), 10) || 240);`（固定缺省 240s，无 180+60×批数式）；`:483` `if (!failed) writeRetroState(...)`——死亡路径不写 state，verdict=failed 无实现。
- 建议：三处机械改（10→5 / timeout 公式 / failed 落账+减半+两死报修），当日可落；v3 已记 10-16 23:46 首死实录（240s SIGTERM code143、11 热点塞一场）为直接动因。

### H2. retro-trigger 源3 零接线 → 第一闭环三路写入对pianist结构性不存在（区a+e）
- 文档侧：`76b28732447b.md:23-26`「## 场景二：task-scoped（尸体复盘，本版新增）…挂到 retro-trigger 源3 钩子（零件全在就差接线）…收尾分身读 session 全文…按第一闭环三路分流写入（tideline/spoor/坑区）」；`:44`「- 源3 接线：supervisor 收尾事件→retro-trigger hook」（挂账待办）
- repo 侧：`src/orchestrator/retro-trigger.mjs:187` `export function createSessionEndHook(...)` 注册位在；全仓 grep `createSessionEndHook|\.register(`（src/ + extensions/，排除 retro-trigger.mjs 自身与 ledger.register 误配）＝零调用方；conductor.mjs:11 只消费 evaluateRetroTrigger/readRetroState（源1/源2 心跳缝）。supervisor/watchman 侧零挂钩。
- 建议：supervisor completionPump 收尾分支挂 `createSessionEndHook().register(...)`（或 watchman 讣告候选位），尸体复盘 prompt 按 v3「三问+三路分流」起稿；method.md 编外黑洞（v3 开题）在此之前无系统解。

### H3. 95k 流水线 v3 两增量：零实现（区c）
- 文档侧：`76b28732447b.md:20`「增量①桥接归属（the user 10/17）：桥接层归 pianist 壳（衔接包=原文精确搬运），tideline 注入配 T0/T3 语义层不配 T2b 桥接层」；`:21`「增量②桥接量实时算…复盘起笔时壳记 coverage offset（盘到第 T_r turn）；切换时桥接包 = (T_r, T_s] 全部原文」
- repo 侧：`src/l0-spine.ts:46-48` 只有 `contextThreshold: 100_000 / narrativeStartLine: 95_000 / bridgeTailMessages: 20`（骨架三件在，与 brief 已知事实一致）；全仓 `grep -rn "coverage|T_r|T2b" src/ extensions/` 零命中——两增量无任何代码痕迹。
- 建议：增量②先行（纯机械：起笔时记 turn 序号、切换时区间切片原文），增量①待 tideline 接入 T0/T3 语义层时同刀落。

### H4. 更夫重拉决策：死因入账有、重拉无（区d，F1）
- 文档侧：`EP-architecture-v2.md:230`「3. **重拉纪律**：每次重拉带三样（死因、死前进度账、第 N 次尝试）」；`:232`「5. **上限与升级**：默认最多 3 次；同一任务 24h 内 ≥3 具尸体＝环境病…停拉转人类」；`orchestrator-split-spec/e65d332d211a.md` F1 节自认「launchPart 已有死法入账…缺重拉决策」
- repo 侧：`src/conductor.mjs:748`「死法一：close 的 signal 非 null…死因随 resolve 带回入账」、`:843`「死于信号 …死因已入账（launch 行 signal 字段）」——死因入账已落；grep `重拉|relaunch|attempt|第N次` 无 part 级重拉决策代码（deploy/rearm-conductor.sh 是 conductor 自身退役补刀，非 part 重拉三件套）。
- 建议：conductor launchPart 死亡分支加重拉计数+三件套注入+3 次上限升级；spec 已把 F1 判为「我写你审」件，可直接施工。

### H5. F3 emit 钩子→中间存在感 + 楼层·实时态：未落（区b+d）
- 文档侧：`orchestrator-split-spec/e65d332d211a.md`「F3 emit 钩子→中间存在感（『在查了稍等』式）」；`EP-Orchestrator.md:90-94`「**楼层·实时态（判断点旁路摘要）**：分身在判断点…native loop 的 emit 钩子（架构 v2 已定）目的地指到台账活账」
- repo 侧：`extensions/pianist-tools.ts` grep `emit` 零命中（遥测钩子 :221-317 四事件面在，无 emit 中间消息钩）；src/orchestrator/ 无「楼层/实时态」模块（grep 楼层仅 review-chain.mjs:63 引交付物字段）。
- 建议：短期用遥测 message_end 近似（弱信号），真件等 Pi extension emit 事件面；蓝图本就标「后开」可接受，但 split-spec F3 已列冻缝清单，应在 conductor roadmap 显式挂账。

### H6. 回流压缩器规则层 v0：未落（区b）
- 文档侧：`EP-Orchestrator.md:103-107`「### 4.4 回流压缩器（三层，规则层 v0 先行）…规则层（默认，零 LLM 零 token）：保留结论/判断/坑…滤除重复性工具调用噪声。v0 由the author盯场解析经验定型，随蓝图施工落地」
- repo 侧：src/orchestrator/ 无压缩器模块（grep `压缩器|compression` 零命中）；floor-summary.mjs 是遥测地板摘要（当前工具/文件/红绿），非「结论/判断/坑保留+噪声滤除」的规则层。
- 建议：floor-summary 与 review-chain 的 deliverableManifest 之间补一层规则剪裁；v0 规则集可从the author盯场解析惯例抽。

---

## 【软缺口·文档滞后】

### S1. README-索引状态列停在 9/29，未记 v2 已落与 v3 已定案（区a）
- 文档侧：`README-索引.md:11`「| 自学习闭环 | EP-自学习双闭环.md | ✅ 定案（9/16-18）；**修订中**：shadow 砍掉改机械入库管线（2026-09-28 the user定向，提案待落） |」
- repo 侧：管线已落——fc14d30（skill-gate 四道闸）+ 31f01f9（retropad v2-2）+ 86b3a75（转正扫描器 inject/use 分层）+ ab85d9c（钉二分流 /skill/auto）；v3 增量已定案归档（76b28732447b，10/17）。
- 建议：索引行改「v2 已落（10/7-11）、v3 增量定案（10/17，两增量+三修待施工）」；EP-自学习双闭环.md 正文 §4 架构图仍画 shadow 路径，加一行「已被 v2 砍除，见 EP-自学习闭环v2提案.md」防新读者走错路。

### S2. docs/orch-v0-real-wiring.md 审链「接线缺口」段被 f8a1c0a 超越，未销账（区b）
- 文档侧：`docs/orch-v0-real-wiring.md:112-113`「**接线缺口**：dispatch 脚本收口位（交货单分支）+ runtime 收尾泵都不调 buildReviewPrompt；蓝图 §5『casting sheet 显式角色（大活必有）』的角色表也没用过审链」
- repo 侧：f8a1c0a（10/16）已落——`src/orchestrator/casting-sheet.mjs:44`「审链: "review"…施工角色行声明『审链:评审员』→ 交付后自动派该角色审」、`src/orchestrator/runtime.mjs:207-230` completionPump 交付分支自动发车审链分身；dea3b78 补 VERDICT 协议分支。docs 内旧结论成误导。
- 建议：该节加勘误行「10/16 f8a1c0a 已收口（runtime 收尾泵路径）」，dispatch 收口位若仍缺则单独留账。

### S3. v2 提案闸三「判而剪」vs 实码「判而不剪」口径不一（区a）
- 文档侧：`EP-自学习闭环v2提案.md:71`「**触发词长度纪律**（KiroCrew 抄）…1-3 词全留；4 词留 3；≥5 词只留 4」（校验器代剪的读法）；`:49`同
- repo 侧：`src/skill-gate.mjs:88-92` 闸三实行为 N≥5 整体打回，代码注释自曝改口径：「闸三 触发词：trigger 按空白切词 N≥5 打回（判而不剪——纪律写给提交者自己剪）」。
- 建议：改 v2 提案 §3 措辞为「判而不剪」（现口径更符合「不替提交者动刀」的审写分离精神），或实现补 pruner——二选一，别两头挂。

### S4. EP-自主探索闭环「抽卡轮转」开放问题悬置未销（区外围，计入矩阵）
- 文档侧：`EP-自主探索闭环.md:64`「抽卡池现在是等概率，要不要按『上一场干了什么』做简单轮转…？（待查 conductor 源码）」
- repo 侧：conductor.mjs 有 rearm/换防相关落码（d70c4d1、4d0378f），但本单未逐行核抽卡轮转实现——文档自己也标「待查」，非虚假声称。
- 建议：轮转问题在 conductor 侧 grep part 轮换逻辑后回填该行，销开放问题。

---

## 【建议·实现超前文档没跟上】

### P1. retropad tickets 第三出口（v2-2.1）未进任何蓝图（区a）
- repo 侧：af28cec「feat(retropad): v2-2.1 infra 工单出口——裁决第三通道 tickets」；`src/retropad.mjs:236-239`「infra 工单出口：错误热点若定位为基础设施/环境层问题…放 tickets 数组」+ 落 tickets.jsonl。
- 文档侧：EP-自学习闭环v2提案 §2 图只有 candidate/nothing 两路，EP-自学习双闭环 §4 无工单通道。
- 建议：v2 提案补第三出口一节（工单与 skill 分流：修壳 vs 长经），否则后来者对 tickets.jsonl 无出处可查。

### P2. 转正判据已细化到 inject/use 分层，蓝图只有一句（区a）
- repo 侧：86b3a75「扫描器对齐定案形状 v0.1——inject/use 分层聚合，inject 按(operator,day)去重，use 全记，转正判据只挂 use 层」；`tools/promotion-scanner.mjs` 头注同。
- 文档侧：`EP-自学习闭环v2提案.md` §4「转正判据 v0：复用 ≥N 次 且零失败喊（N 不拍死…）」——无 inject/use 之分。
- 建议：判据形状回填蓝图 §4（防「曝光次数冒充复用」的口径丢失）。

### P3. 凭证柜三代成体系，EP 文档族无专节（区f）
- repo 侧：T11 0c44c84（钥匙柜四角色+审批分层+指纹兜底）→ T15 543b853（env 过渡态下线：柜优先/env 回落/双无大声死）+ 9b08d0c（T15b 沙箱隔墙喊 broker）→ T16 467884b（sidecar 来历+scope 快照+墓碑+hui三问），docs/credential-vault-v2.md 在 repo。
- 文档侧：EP-architecture-v2.md 只有「沙箱内零凭证（工具路由姿势）」一句铁律，无凭证柜章节。
- 建议：EP 族加「凭证卫生」节（三代演进+三态供给+审批三档），指向 repo docs；现状是安全关键件只活在 repo 文档层。

### P4. schedule 骨头层（277cead+docs/schedule-spec-v0.1.md）未上 EP 地图（区外围）
- repo 侧：277cead「feat(conductor): schedule 骨头层——消费缝接进 tick（忙判后/抽卡前），错过跳过不补跑」；src/schedule/{evaluator,store,index}.mjs 三件+spec 文档。
- 文档侧：EP-Orchestrator §10 只说「会话编排归 conductor 侧两案分立」，无 schedule 条目。
- 建议：README-索引 或 EP-Orchestrator 补一行指针（会话编排侧新增件），保持「一块模块一份文档」的自称。

---

## 待核（单侧证据，不进正档）

- T1. D1 桥本体（Moonshake eventlog→event-queue 单写者桥）：split-spec 判给hui svps 侧；本 repo 仅消费面已落（conductor.mjs:145-162 env-event part、:371-395 ssh 拉表、9786e41 本地优先、83eb3ed 冷却闸双源）。桥在不在 svps，本 repo 不可证。
- T2. 山海侧注入平权回音：shanhai-auto-parity-doc 请hui核「消费侧有无状态过滤」，档案房未见回音件。
- T3. grimoire_event kind 集合 9 值（bridge-catalog.mjs description「kind（9 合法值）」）vs EP-契约-skill生命周期账本事件表 8 kind——多出哪个、是否 parity 漂移，需山海侧账本实核。
- T4. 旧 commit 引用失效：九洞收口档案引 a166868/55ed0b2/2cb3882、parity 文档引 ab908f4——当前 git（史根 410bb2f 开源化重写，共186 commit）均不可见。档案→repo 回溯链对 10/6 前的 hash 断裂，只能靠文件现码对账（本单即此法）。
- T5. EP-契约-skill生命周期 策展人 cron/巡山使四路线/one-mutation budget：山海侧机制，本 repo 无对应面（经图开场注入四件套+darkzone 名单已实证吻合，本 session 系统提示即活样本）。

---

## 阴性对照（验收标准第4条）

**抽「审链自动编排」判已落，给反向证据**：
- 正证：casting-sheet.mjs:43-44 两列语法 + runtime.mjs:111,207-230 completionPump 自动发车 + git f8a1c0a/dea3b78。
- 假如没落会看到：① `grep -n "审链" src/orchestrator/casting-sheet.mjs` 空（现实=44 行命中）；② runtime.mjs 无 `extractReviewBindings` import（现实=:42 在）无 reviewBindings.get 分支（现实=:210）；③ git log 无 f8a1c0a；④ 最硬的端到端反证——**本任务书自己的角色表**「角色:worker pianist … 审链:评审员」「角色:评审员 … 模型:zai-coding-cn/glm-5.3-flash」两列若无解析面，编排器发车即 fail-load 或整行忽略，评审员分身根本不会被派出来。任务书行级依赖该语法＝活的消费证据。
