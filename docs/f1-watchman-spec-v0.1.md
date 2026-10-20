# F1 更夫重拉规格 v0.1（the author，2026-10-18）

## 定位一行

讣告（obituary.mjs，已落）管死后的账，更夫管死前后的拉起决策——launch 死了之后的机械判定：拉不拉、拉几次、什么时候停手转人类。收尸协议常驻化 + 按确认集自动决策（the user 10/18 语义：确认集必收尾自动扶、未确认记一笔不扶）。

## 依据（正典锚点）

- EP-architecture-v2.md「更夫」节六条（桌面正典）：活人报平安/死因分类/重拉三件套/确定性死因劈两半/上限与升级/更夫是确定层最小组件
- orchestrator-split-spec F1：launchPart 已有死法入账（pid/exit/signal/tail），缺重拉决策
- t16-audit gap-list H4：死因入账有、重拉无
- the user 10/18 拍板：死因/attempt/死前进度全归确定层；「扶不扶」按烂尾原则机械化
- hui #1052（2026-10-18）：裁决缝——「错过跳过不补跑」vs「断电孤儿必扶」两规打架，终审见 ② 输入分类节
- hui #1055（2026-10-18）：裁定过、可开工；两条开工条件——①验收 8 缺触发面（fired-无行 × launches 反查进扫描面）②任务型落缝报备升档（hearth报备转人）——细化见 ①-补 节

## 范围（先立墙）

**管**：conductor 自己 spawn 的两类 launch——
- schedule 条目消费（consumeSchedule 的 launchPart，`launches` 行带 `sched` 字段）＝**任务型**。现状缺口：`entry.status='fired'` 是终态，part 死了条目永远停在 fired——静默丢失，无人重拉。这是本刀的第一个真实用户。
- 抽卡班次（tick 的 launchPart，五张牌）＝**班次型**。现状：死了只 console.error，下轮 tick 自然再抽——行为已对，watchman 只补一行判定账，不改行为。

**不管**：
- dispatch 线（driver-real spawn 的pianist工单）——驱动器 v2.1 双时钟已是它自己的更夫；「编排器同单双实例」另开工单
- retropad 心跳拉起（heartbeatRetroFire）——成败同窗冷却已是自己的重拉纪律，套监工＝无限回归（架构 v2 第 6 条）
- 修理工 session（确定性死因 agent 能修的拉修理工）——v0.1 只做「停拉转人类」，修理工是 v0.2 候选

## 六条拍板

### ① 死因分类（机械五分，全部可测）

| 死状 | 判据（launches 行字段） | 分类 |
|---|---|---|
| 干完死 | `exit===0` | done，永不重拉 |
| 出错死 | `exit!==0`，signal 空 | crash（非确定性） |
| 信号杀 | `signal` 非 null 且 ≠ `parent-down` | killed（非确定性） |
| 父进程停机 | `signal==='parent-down'`（markPendingLaunchesDown 补的） | 环境死，不算 session 的错 |
| 机器重启孤儿 | 有 pending 行、conductor 重启后发现无 exit 无 signal 且进程已不在 | 环境死，不算 session 的错（10/18 断电孤儿 v4-3 案：这类现在连账都没有——watchman 开机首 tick 补验尸） |

心跳断进程在＝卡死：conductor 的 launch 是 await 子进程，看不到这态，归 driver 线，不碰。

### ①-补 缝①缝②施工细化（hui #1055 两条，开工条件）

**缝①（fired-无行缝的反查触发面）**：验收 8 的输入类是「status=fired 且 launches 无对应行」——它根本没有行可扫，开机首 tick 的 pending 行扫描永远看不见它。修法＝首 tick 验尸扫**双面**：

- A 面（原有）：`state.launches` 里 pending 无终态的行（断电孤儿）
- B 面（新增）：schedule entries 里 `status==='fired'` 的条目 × `launches` 窗口反查（行匹配 `sched===entry.id`）——无行命中即判定行 log-only 出声

**B 面新鲜度护栏（必钉，否则开机即骚扰）**：`launches` 是 200 行滚动窗口——老 fired 条目的行早被挤出窗，无护栏的反查会把全部历史 fired 条目当缝报一遍（假阳洪水）。判据＝`entry.fired_at`（conductor.mjs:830 spawn 前落盘）距今 **≤24h 才入判定**；>24h 的老 fired 静默忽略（与孤儿 24h 新鲜度同一把尺：隔夜的缝，人醒了自己看）。

**缝②（任务型落缝的报备升档）**：fired-无行缝的 verdict 照旧 log-only 不自动补（launches 无行不能证明 session 没跑过——行可能只是被窗口挤出，自动补有重复跑风险，hui #1055 认可此判）。但缝里消失的是**过了确认线的任务**（schedule 条目进门都过the user/排序确认线，确认集语义=必收尾），console 行太轻。升档＝任务型（sched 字段）落缝时，判定行之外**追加hearth报备一条**：POST `/api/send` 大厅，sender=`conductor`，文本=讣告同款形状（sched id+死因=fired-无行缝+fired_at+建议动作「launches 无行不能证明没跑过，请人对一眼再定补不补」）——**复用 spec ⑥ 停拉转人的hearth报备同款路径，零新增机制**。失败不拦判定不拦抽卡（spec ⑥ 同款纪律）。班次型落缝照旧 log-only 不报备（日常运转不是承诺）。conductor 当前无hearth HTTP 客户端，本刀新建（fetch，超时 5s，hearth地址 env `HEARTH_URL` 缺省 `http://172.26.176.1:7788`）。

**B 面判定的幂等**：同一 entry 的缝判定行，24h 窗内只出一次（`state.watchman.seamShouted[schedId]` 记名，orch-Watchman shouted 同款幂等纪律）——重启不重报。

### ② 重拉决策表（确认集语义的直接映射）

**输入分类**：schedule 骨头的正典是「错过跳过不补跑」（schedule-spec §五.3，the user 10/12 拍板），F1 说断电孤儿必扶补拉——裁决判据＝**launches 表有无该 sched id 的行**，即「这条 schedule 到底有没有真正拉起过一个 session」：

| 场景 | 账面形状 | 归属 | 处置 |
|---|---|---|---|
| 错过 due | due 已过、entry.status≠fired | schedule-spec §五.3 | 跳过——watchman 不碰未拉起的条目（「机器没开就是没开」正典不动） |
| fired-无行缝 | status=fired、launches 无对应行（标完 fired、spawn 前断电） | 视同错过 | 跳过 + log-only 判定行出声（现状此缝静默，出声为对账） |
| 断电孤儿 | launches 行在、无 exit 无 signal | F1 | 环境死 → 任务型 heal 补拉（attempt 不计） |
| 已有终态 | exit/signal 已落 | F1 ①五分表 | 照常判 |

一句话：**「错过跳过」管从未拉起的，「补拉」管拉起过死掉的。机器没开没拉＝没开就是没开；拉起来了被机器连累死＝确认集语义，必扶。**

```
任务型（sched 行）：
  done        → 不拉
  环境死      → 补拉，attempt 不计数（机器的错不算 session 的错）
  crash/killed→ 重拉，attempt+1，注入三件套
  attempt≥3（24h 窗，同 sched id）→ 停拉转人类：hearth报备 + STATUS 落「待审·人」行 + 讣告形状（死因分类+最后心跳+重拉史+建议动作）

班次型（抽卡行）：
  任何死状    → log-only：判定行照出，不拉不计数（下轮 tick 自然再抽＝既有的正确行为）
```

任务型＝确认集的机器可读代理：schedule 条目进门时都过the user/排序确认线，所以死了必扶。班次型是日常运转不是承诺，死了记一笔。

### ③ 三件套注入（重拉时 prompt 前缀，不是任务书改写）

重拉的 launch 在原 prompt 前加一段：

```
【更夫重拉·第 N 次尝试】
- 死因：<signal|exit code> ＋ 尾 300 字（launch 行 tail）
- 死前进度：上次拉起 <ts>，运行 <ms>，事件游标 <events 字段>
- 上次会话工作区工件未被清理，接着干，不从头来（A3 spool 语义）
```

进度账 v0.1 从简：launch 行自带字段全给（ts/pid/ms/tail/events 游标）。遥测深读（message_end 地板）留 v0.2。

### ④ attempt 台账（state 面，schedule store 零改动）

- `state.watchman = { relaunches: { [schedId]: { count, firstTs, lastTs, history: [{ts, signal, exit, tail300}] } } }`
- 24h 窗滑动：`firstTs` 出窗则计数清零重起算（新的一天新的三次机会——环境病好了该让跑）
- 补拉的 launch 行加 `relaunch_of: <原行 ts>` 链成环——账上可追「这次是替谁跑的」
- schedule 状态机不碰：`entry.status` 保持 fired（评估器不认终态的既有语义不动），重拉与否全看 watchman 账
- **heal 独立计数**：`healCount`（同 sched id，同 24h 滑动窗）——环境死不进 crash attempt 账（机器的错不算 session 的错，验收 3 不变），但环境反复死也非无代价：healCount 连续 3 次 → 同样停拉转人类（防「断电-补拉-又断电」无限重启循环）

### ⑤ 落点与形状（照 retro-trigger 样板）

- `src/watchman.mjs`：纯函数 `evaluateWatchman({ deadLaunch, prior, isTaskLike })` → `{ verdict: 'relaunch'|'heal'|'stop-human'|'log-only'|'done', attempt, reason }`，零 IO 零 LLM
- conductor 两处死亡分支（consumeSchedule :843 附近 + tick :1040 附近）挂判定；relaunch verdict 时 spawn 前**先写后做**落新 launch 行（relaunch_of 链）再 launchPart
- 判据行格式钉死（可断言面，测试不翻源码）：
  `[conductor] 更夫判定：task=<sched:N|part:X> verdict=<relaunch|heal|stop-human|log-only|done> reason=<...> attempt=N/3`
- 开机首 tick 补验尸：state 里 pending 无终态的行（断电孤儿），机械判「环境死」——只有任务型走 heal，班次型出声即止。孤儿 heal 带 **24h 新鲜度**：launch 行 lastTs 距今 >24h 不自动补，停拉转「待审·人」（隔夜太久的半成品让人看一眼再定——确认集要收尾，但超过一天的收尾权归人）。10/17 那种 v4-3 从此开机 5 分钟内有人对账（hearth #1044 线的机械化）

### ⑥ 上限与升级（架构 v2 第 5 条原样）

- 默认 3 次（env `CONDUCTOR_WATCHMAN_MAX=3` 可调，测试用）
- 触顶后：**停拉转人类**。转法＝hearth报备一条 + spoor journal 落「待审·人」（带死因分类+重拉史+建议动作栏）——不自动做别的。判断只剩最后一公里，这一公里归人
- watchman 自己异常自己吞不拦抽卡（hotspot/retro 心跳同款纪律：骨头断了肉照长）

## 验收（阴性对照是灵魂）

1. **拔插头**：watchman 模块缺失/抛错 → conductor 照旧跑（tick 不因更夫死而死）
2. **exit=0 永不重拉**：干完死的行任何情况下不产生 relaunch（钉死）
3. **parent-down 不计数**：连续两次 parent-down 补拉后，attempt 仍为 0
4. **三尸停拉**：同 sched id 三次 crash 后，第 4 次死亡 verdict 必须 stop-human，且无新 launch 行
5. **突变**：`CONDUCTOR_WATCHMAN_MAX=2` 后第 3 次死即停（上限真在读不是写死）
6. **断电孤儿**：造一行无 exit 无 signal 的 pending 行重启 conductor，首 tick 出判定行，任务型 heal、班次型 log-only
7. **判据行格式**：全部测试断言 console 行形状，不翻源码
8. **fired-无行缝**：造 status=fired 且 launches 无行的条目 → 判定行 log-only、不补、无新 launch 行（错过跳过正典的缝内适用）。**任务型**另加断言：hearth报备发出（sender=conductor）+ 同 entry 重启不重报（seamShouted 幂等）+ 班次型无报备
8b. **反查新鲜度护栏**：fired_at 距今 >24h 的 fired 条目（老行已被 200 行窗口挤出）→ 无判定行无报备（假阳洪水阴性对照）
8c. **报备失败不拦路**：hearth不可达（HEARTH_URL 指向死端口）→ 判定行照出、抽卡照跑、无 crash
9. **heal 上限与新鲜度**：同 sched id 三次环境死补拉后第 4 次环境死 verdict=stop-human；lastTs 距今 >24h 的孤儿首验即转待审·人不补

## 家规速记

先写后做（relaunch 行 spawn 前落盘）；失败必喊（stop-human 必出hearth）；零 LLM 零外部依赖（确定层最小组件）；单 session 预算内闭环；commit 完 @hui审 diff+突变，钉子有牙才关账。

## 施工清单（本刀四件）

1. `src/watchman.mjs` 纯函数 + 判据行
2. conductor 两缝接线 + 开机首 tick 补验尸（A 面 pending 行 + B 面 fired×launches 反查带 24h 护栏）+ state.watchman 面（relaunches/healCount/seamShouted）+ hearth报备客户端（fetch, HEARTH_URL, 5s 超时，失败不拦）
3. `test/watchman-test.mjs`：验收 1-9（含 8b/8c）全覆盖 + 突变
4. npm test 挂链 +全套回归（1023 基线不许掉）

v0.2 候选（不进本刀）：修理工 session（确定性死因劈两半的另一半）、进度账遥测深读、dispatch 线同款纪律移植。
