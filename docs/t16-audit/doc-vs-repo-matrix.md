# t16-audit 三方对账矩阵（doc-vs-repo-matrix）

计数口径：「声称条目」=文档中可对 repo 验证的可执行声称（不含纯讨论/开放问题/上游参考）；已落含 v0 雏形；「外部」=声称对象不在本 repo（山海/spoor/svps 侧），本单无法闭合。EP 文档族实为 **8 份 EP-\*.md**（任务书写 7 份，见异常区）+README，全列。

## ① 桌面 EP 文档族

| 文档 | 声称条目 | 已落 | 未落 | 部分落 | 外部/待核 | 代表例 |
|---|---|---|---|---|---|---|
| EP-architecture-v2.md | ~34 | 19 | 6 | 5 | 4 | 已落：三层定型/壳永不调LLM/MCP归壳/遥测存档/L0桥接+最简压缩/100k-95k骨架/沙箱⑤容器档+契约四魂(sandbox.mjs头注)/更夫死因分类入账。未落：更夫重拉决策(:230-232)/microVM档(⑦,判别位throw=按期)。部分：四环③95k增量零实现/四环④spoor代写(env-event本地优先在,语义开档无)。外部：microsandbox引擎/Tideline线 |
| EP-Orchestrator.md | ~28 | 19 | 3 | 3 | 3 | 已落：casting sheet角色表+审链+模型列(f8a1c0a)/任务书lint v0(lint.mjs 2规则,advisory,退出码0/1/2)/台账/地板(floor-summary)/讣告三源(obituary)/收件箱FIFO(inbox)/watchman(c9ca2bd)/失败语义模块/沙箱档位表(sandbox-tiers:审→no-ext-net)/深度衰减(prompt-builder)。未落：回流压缩器规则层/楼层实时态emit。部分：审链「实战首单」10/16起有runtime路径,dispatch路径未销账(orch-v0-real-wiring:112)。外部：弱模型层/前台收件箱UI |
| EP-自学习双闭环.md | ~30（v1，大半被v2/v3取代） | 14 | 8 | 4 | 4 | 已落：遥测存档/热点扫描器两维/retropad发现问/拆卸测试/九洞收口/错误统计机械化(errorHotspots)/健康问占位(retropad.mjs:234,377)。未落：DR指标/考题栏独立件/七维度框架/到期预算(shadow家族已被v2砍,文档滞后)。外部：Tideline质感叙事/spoor坑区 |
| EP-自学习闭环v2提案.md | ~16 | 12 | 1 | 2 | 1 | 已落：四道闸(fc14d30,skill-gate.mjs:50-99)/auto/前缀隔离(:20-24)/打回带原因/新兵区钉二分流(ab85d9c,shell.mjs:255-257)/转正扫描器v0.1(86b3a75)/注入平权(经图auto/条目开场可注入——本session系统提示实证)。未落：转正阈值N拍板(开放问题,实码--min-reuse可配)。部分：闸三判而不剪(S3)/复盘分身事件驱动(源1/2接conductor,源3零接线H2)。外部：山海消费侧过滤核验(T2) |
| EP-自学习发现路自审材料-v1.md | 18（自记✓12/✗5/⚠1） | 16 | 0 | 1 | 1 | 自记✗五项(健康问/DR/考题栏/七维/到期预算)中健康问已由洞2占位收口(55ed0b2档案记,现码retropad.mjs:377在)；洞1出声/洞4近亲名单(darkzone进摘要)/洞9 stderr落账均已收(fed71e93864c)。key硬编码洞6由T15/凭证柜线收编。代表：九洞5/9+3件收口 |
| EP-自主探索闭环.md | ~10 | 8 | 0 | 1 | 1 | 已落：wander part空闲触发/预算20硬顶/WANDER-OPS文档族(15份9/26-10/15实存)/notify_claim T3/收尾笔记≤200。部分：抽卡轮转「待查」(S4)。外部：探索实验场(microVM⑦) |
| EP-契约-skill生命周期.md | ~22 | 6 | 0 | 2 | 14 | 已落(本repo桥面)：开场四件套注入(tag树+映射+查询语法+core全文,darkzone名单——本session实证)/skill记录字段(tags/trigger/boundary/why/status)/draft起步。部分：账本事件8kind vs 桥9值(T3)/usage回路(尾行搭车,桥description有「报不报随意」)。外部：状态机转正裁决/策展人cron四路线/one-mutation budget/入关三面扫/别名归并——全在山海侧 |
| EP-分身记忆三件套蓝图.md | ~9 | 3 | 1 | 2 | 3 | 已落：涂鸦房scratch(spor_scratch_*桥面在)/档案房archive_put/get/list/query(桥面在)/processed门槛字段(sp侧)。未落：回流压缩器引擎(H6同源)。部分：mark词汇表(桥用mark可选项)。外部：hui引擎本体/UI |
| README-索引.md | 8（状态行） | 5 | 0 | 3 | 0 | 滞后3行：自学习「提案待落」实已落(S1)/Orchestrator「v0.1蓝图」实已⑧-2 live+审链自动/索引无凭证柜无schedule条目(P3/P4) |

## ② spoor 档案链

| 档案 | 版本 | 声称 | 已落 | 未落 | 部分 | 外部/待核 | 代表例 |
|---|---|---|---|---|---|---|---|
| portalk-selflearning-loop | v1(8006ee0bbdcf) | 12 | 7 | 3 | 1 | 1 | 同EP-双闭环口径 |
| 〃 | 9/18增量(87890b80b4a8) | 6 | 6 | 0 | 0 | 0 | 三道闸门/可拆卸四条全落(拆卸测试两场过,自审材料§1) |
| 〃 | 施工③快照(5397dbd28d63) | 5 | 5 | 0 | 0 | 0 | 遥测钩子/扫描器17/17/retropad/壳ingest——git史重写后hash断,以现码对(异常区#4) |
| 〃 | 九洞收口(fed71e93864c) | 9 | 9 | 0 | 0 | 0 | 洞1/2/4/9+钉子+engines(旧hash不可见,现码在) |
| 〃 | **v3(76b28732447b)** | 10 | 1 | 6 | 1 | 2 | 已落：v3定案归档本身+观测基线(resprobe)。未落：三修(H1)/源3接线(H2)/增量①②(H3)/环境说明书(grep空)。部分：场景一重申件(骨架在)。外部：T16本单(进行中) |
| portalk-runtime-dependency-map | v0.1→v5(5版) | ~20 | 16 | 1 | 1 | 2 | 已落：三层定型全链/四环①②/遥测v1格式(extensions:221-317与档案ab4948632e86同形)。未落：emit钩子。外部：Tideline/前端主题视图 |
| portalk-contract-skill-lifecycle | v0.1+v0.2(2版) | 同EP-契约 | — | — | — | 全外部 | 桌面A4同文快照,b575c8a0e3ff≈v0.2 |
| portalk-sandbox-structure | ff4c901a2005 | 8 | 7 | 1 | 0 | 0 | 已落：8方法契约/四魂/容器档加固清单(sandbox.mjs逐条对应)/零凭证(T15b broker)。未落：microVM档(⑦按期) |
| portalk-telemetry-v1 | ab4948632e86 | 5 | 5 | 0 | 0 | 0 | JSONL v1格式/四事件/32KB拒检/按天轮转——extensions/pianist-tools.ts逐项在 |
| orchestrator-split-spec | e65d332d211a | 12 | 6 | 2 | 1 | 3 | 已落：D1消费侧(env-event part+replay_day+LIMIT+饿死退避conductor:893-899+本地优先9786e41)/F2全件。未落：F1重拉决策(H4)/F3 emit(H5)。外部：D1桥本体svps(T1)/D2投递裁决/P2 consent tier |
| shanhai-auto-parity-doc | 9fbea72a2633 | 6 | 5 | 0 | 0 | 1 | 我侧五声称全与repo吻合(四道闸/auto命名/amber降级/403圈死/转正管道)。外部：hui回音(T2) |
| spoor-facts-table-spec | v1+v2(2版) | 9(J1-J7+边界) | 2 | 0 | 1 | 6 | 已落：pianist消费形状「上游已探明」节(本任务书「已知事实·the author已核,直接采信勿重探」即活实证)/TTL思路。外部：表本体/J1-J7机判/spoor侧读写口 |

## ③ repo 实况反向账（实现有、文档无 → 全入 gap-list P 档）

| repo 件 | 证据 | 缺档处 |
|---|---|---|
| tickets 第三出口 | af28cec/retropad.mjs:236-239 | EP/v2提案无(P1) |
| inject/use 分层转正判据 | 86b3a75/promotion-scanner头注 | v2提案§4一句带过(P2) |
| 凭证柜 T11/T15/T16 三代 | 0c44c84/543b853/9b08d0c/467884b+docs两份 | EP族无专节(P3) |
| schedule 骨头层 | 277cead/src/schedule/+spec | EP地图无(P4) |
| VERDICT 协议 | dea3b78/runtime.mjs:189-190 | EP-Orchestrator §5无 |
| 审批上浮/壳隔离铁律/灾备两件套 | ea0b9d4/2080d07/e7c79fa | EP-Orchestrator §6/§7 无对应节（失败语义表有模块无逐行对账） |

## 六区覆盖勾稽

| 区 | 已落代表 | 缺口编号 |
|---|---|---|
| a 自学习双闭环 | 四道闸+auto/新兵区+转正扫描器+遥测+拆卸测试 | H2（三路写入断链）S1 S3 P1 P2 |
| b 编排器⑧ | casting sheet/审链/模型列/watchman/lint/讣告/收件箱 | H5 H6 S2 |
| c 95k 流水线 | l0-spine 骨架（100k/95k/衔接包20条） | H3（两增量） |
| d D/F 线 | D1消费侧全件+F2 | H4 H5；T1（桥外部） |
| e retropad+源3 | 源1/2 已接 conductor tick（544f088） | H1 H2 |
| f 凭证柜三代 | T11/T15/T16 全落 | P3（EP缺节） |
