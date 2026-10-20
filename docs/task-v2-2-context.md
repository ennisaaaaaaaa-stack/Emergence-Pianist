# v2-2 施工上下文（冷启动指针——给施工分身的地图，不是任务书本身）

任务书：data/casting-sheets/2026-10-10-v2-2-retropad-orch.md（本文件是它的指针目标）
蓝图：<user-home>/Desktop/Portalk设计文档/Emergence-Pianist/EP-自学习闭环v2提案.md（§2 架构图、§5 复盘分身角色卡、§6 施工顺序）

## 已有资产（别重造）

1. src/hotspot-scanner.mjs — 机械热点扫描（已活）。产出 data/hotspots/latest.json，形状 {hotspots:[], errorHotspots:[], params, generatedAt}
2. src/skill-gate.mjs — 入库前四道闸（已活，62 断言）。挂在壳侧 grimoire_submit 前，只对 auto/ 前缀生效
3. src/retropad.mjs — 复盘分身拉起器 v1（已活但裸 spawn pi -p，不走编排器）。有 dry-run/零热点早退/报告形状坏 exit 2/裁决 JSON 提取/draft 近亲名单/投 Grimoire 全链
4. src/orchestrator/ — ⑧-2 编排器全家桶（已活，719 PASS）。入口 buildRuntime({sheetText, ...opts})（runtime.mjs），返回 {ledger, inbox, launchMinion, launchSheet, pollBeats, sweep, startLoop, stop, ...}

## 两铲的活

### 第一铲：retro-trigger.mjs（纯逻辑，零 LLM）

蓝图 §5 触发器三事件源：
1. 热点阈值：hotspot 报告里 hotspots+errorHotspots 总数 ≥ 阈值（建议缺省 3，可注入）
2. 抽检到期：上次复盘时刻 + 间隔 ≥ now（读 data/hotspots/ 或独立状态文件的 mtime/内嵌时间戳；无历史=立即到期一次，给首战铺路）
3. 收尾钩子：session 收尾事件回调注册位（钩子坏了扫描式兜底常在——蓝图原话，钩子只是加速器不是命脉）

输出形状：{ fire: true|false, reason: "threshold"|"due"|"hook"|"none", detail }。纯函数可测，时钟注入。

### 第二铲：retropad 收编编排器

src/retropad.mjs 改造：
- 保留：报告解析/零热点早退/dry-run/draft 近亲名单/裁决 JSON 提取/投 Grimoire
- 替换：裸 spawn pi -p → buildRuntime + launchMinion（角色=复盘分身，走任务书）
- 复盘分身的任务书可以内联生成（代码里模板字符串），角色表 1 人，沙箱列按蓝图角色卡=workspace-write 禁外网（映射到 no-ext-net 档）
- 收尾：分身退场后从收件箱交货单取裁决（替代现在的 stdout 尾部 JSON 提取——交货单 manifest.tail 里有，或 floorSummary）；裁决形状校验保持
- 心跳免费拿：编排器 watcher 自动接（会话源+遥测源）

### 测试形状（零真钱）

- retro-trigger-test.mjs：三源各自触发/全不触发零拉起/时钟注入
- retropad 收编回归：stub pi（ORCH_PI_BIN 指 node -e 风格 stub，学 orch-real-driver-test.mjs 的 stub 写法）——stub 输出裁决 JSON+DONE，断言：台账「收」、交货单进收件箱、零热点时不 spawn（阴性对照）
- 既有 test/retropad-roster-test.mjs 不许红（它测的是 draft 名单拉取路径）

## 坑账（前人踩过的）

- pi 会话落 ~/.pi/agent/sessions/--cwd-sanitized--/ 子目录，watcher 已改递归扫（今天刚修，别退化成单层）
- 静默钟盯 stdout 无效（pi -p 最后一把吐）——心跳源=会话文件 mtime/遥测 jsonl，编排器已内置
- spawn 钥匙走 envOrVault("ZAI_CODING_CN_API_KEY", "coding-plan", context)，context 要带 retropad 标识
- piBin 以 .mjs 结尾直接当入口；测试 stub 就用这招
- no_proxy 必须含 127.0.0.1,localhost（壳地址不走环境代理）

## 施工纪律

- 不 commit 留工作区（复验绿主 agent 收账）
- npm test 全绿才算干完（含所有既有测试零回归）
- 遇歧义 BLOCKED:歧义: <明细> 退出，不当裁判
- 环境缺东西 BLOCKED:环境: <缺什么> 退出
