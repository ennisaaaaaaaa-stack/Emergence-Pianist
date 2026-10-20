# F3 存在感（emit 钩子·收窄版）规格 v0.2（the author，2026-10-19 起稿；同日 v0.2 收hui #1086 审缝）

> v0.1→v0.2 changelog：①文件名钉死——v0.1 起直接按日翻篇 `emit-<date>.jsonl`，不留单文件过渡（语义 3/实现面 3/验收 1 三处统一）；②架构墙验收改剥注释 grep，纪律正本写 README、文件内不提被禁词（红线不打红自己）。

## 定位一行

「在查了稍等」存在感的机械化最小版：F 线 emit 钩子收窄回 emit 事件本身，不与 Hermes 串 session（the user 10/18 拍板：「F3 修正后收窄回 emit 钩子不与 Hermes 串 session——编排归属各管各」）。

## 背景

F3 原案（split-spec F3）设想过「并行 session 也是分身」的统一名册——把 Hermes session 登记进编排器台账实现跨 session 可见性。10/18 拍板收窄：那条线动的是「谁看见谁」的架构面，牵扯 session 归属（编排全归 pianist 最高纪律），一刀切进 emit 钩子会与 Hermes 的 session 概念串味。收窄后的 F3 只做一件事：**编排器在干活时对外发心跳事件，让外部（hearth/桌面/任何听者）知道「在查了稍等」**。

## 语义（拍板翻译成机械规则）

1. **emit 钩子**：runtime 在关键节点发事件（不是消息）——事件形状 `{ v:1, ts, kind, source:"orchestrator", data }`
2. **kind 枚举（v0.1 最小集）**：
   - `dispatch.started` / `dispatch.exited`——pianist发车/收车（driver-real 已有 spawnLog，补 emit 面）
   - `verdict.received`——审链裁决到了（VERDICT 落收件箱时）
   - `watchman.judged`——更夫判定行（F1 已有 console 行，补 emit 面）
   - `escalation.human`——停拉转人类（F1 的hearth报备已有，emit 面补一份给非hearth听者）
3. **事件落点（v0.1 起即按日翻篇）**：`data/events/emit-<date>.jsonl`（append-only 日，Moonshake day file 同款形状，`<date>`=JST 日）。v0.1 不设单文件 `emit.jsonl` 过渡态——按日翻篇从第一行起就是正典（文件名三处口径统一：本节/实现面 3/验收 1）。**不推hearth不推桌面**——那是消费方的事，emit 层只管发生。谁想听谁 tail 当日文件（hearth报备、F2 清理行、更夫判定行都是既有通道，不重复建设）。
4. **不与 Hermes 串 session**：emit 事件不含 Hermes session id、不写 Hermes 侧任何状态、不依赖 Hermes 在场。编排归属各管各——pianist 的事件账自己记自己听。
5. **「并行 session 可见性」的答案挂账**：统一名册方向不删（她半夜问「能否看到并行 session」值得架构级回答），但另立 F3-2 讨论稿，不混本刀。

## 范围（先立墙）

**管**：orchestrator runtime 的 emit 面（上面五 kind）
**不管**：
- 消费方（谁听 emit.jsonl、听见了干什么——hearth/桌面/未来 dashboard 都不管）
- Hermes session 名册（F3-2 讨论稿）
- driver 线遥测（pianist-dev-*.jsonl 已有，不重复）

## 实现面（施工预估：纯函数 + 五个 emit 点 + 一份测试，单分身一铲）

1. `src/orchestrator/emit.mjs`：`emitEvent(kind, data)` —— append `emit-<date>.jsonl`（按日翻篇，date 由 F2 同款 `nowJstDay()` 单点钟给——两把刀一套钟）+ 失败不拦主流程（同hearth报备纪律）
2. 五个 emit 点接线（driver-real 两处 / completionPump verdict / watchman 判定 / escalateHuman）
3. 文件名即翻篇：直接写 `emit-2026-10-19.jsonl` 形状，无单文件过渡态。文件不清理（月度归档归运维）。架构墙纪律正本住 README 与本 spec（本节+验收 5），**emit.mjs 文件内不出现被禁词**——注释里也不写（写「本文件不得出现 session 字样」这句话本身就含 session，红线会打红自己）

## 验收（可证伪）

1. 发一单 → 当日 `emit-<date>.jsonl` 出现 dispatch.started + dispatch.exited 两行，shape 对（文件名含当日 JST 日期）
2. 审链单 → verdict.received 行在
3. 更夫判定（测试触发）→ watchman.judged 行在
4. 阴性对照：emit 写失败（chmod 只读）→ 主流程照跑不炸，console.warn 出声
5. 架构墙（剥注释 grep）：`grep -iE 'hermes|session'` 前先剥掉行注释与块注释，**对剥后代码**做匹配，emit.mjs 零命中——被禁词连注释都不进文件，grep 无需特赦任何自指豁免

## 依据（正典锚点）

- the user 10/18 拍板（journal 2026-10-18 17:17 判断账）：「F3 修正后收窄回 emit 钩子不与 Hermes 串 session——编排归属各管各」
- hui #1086 审缝（2026-10-19）：文件名三处打架钉死按日翻篇、剥注释 grep——v0.2 全部收编；day 判定共用 F2 钟屋单点钟
- F3 存在感原语义（split-spec F3）：「在查了稍等」——本 spec 是它的最小机械版
- EP-architecture-v2「更夫」节第 6 条（更夫是确定层最小组件）——emit 钩子同款定位哲学
