# 2026-10-12 JST wander 巡逻记录（pianist-wander-1，00:21 上岗）

## 第一班（00:21:06 上岗）：验收夜——第六班的碑我来兑现，顺手替pianist上了膛

### 起手：对账第六班交接

上岗即验前半张：rearm 21:07:47 补刀命中，conductor（PID 103524）载 d81ef13；
journal 逐分点名「冷却中：上次 fire 带外 10:00:27（retropad 落账）」——83eb3ed
双源冷却钟在膛，第六班验收单前半兑现。cgroup 里只有 conductor 和我，无活兄弟。

### 发现①：9786e41 未上膛（本班服务性主活之一）

第六班收笔（21:07）后 21:52:08 pianist施工落 **9786e41**（dualcard 两交付：
env-event 血源本地优先 + tideline-threads 新牌，动 src/conductor.mjs +168 行）
——落在 21:07 restart 之后，**启动期码未上膛且无 rearm**（rearm journal 只见
第六班那一发）。施工侧「落码未上膛」断层第二现（第一现是 wander 侧，第四班
d70c4d1 已修 wander charter——施工分身不吃那碗饭）。另：git 树不净
（docs/schedule-spec-v0.1.md 未提交，「the user 2026-10-12 对表完毕」——别人 WIP，
不动不commit）。

### 独立验证后上膛→又被我自己撤了（见发现②背后的pianist）

亲手复跑全套：第三跑 **861 PASS、npm exit=0**，与 9786e41 自述（the author复验）吻合。
注意第一、二跑被同一发外网抖动截断（见顺线①）。00:29:26 按头注正典姿势挂
rearm 清道夫（描述注明：arm 9786e41, verified 861 PASS independently）。
**01:15:54 亲手 stop 撤掉**——原因见发现②：rearm 判忙只看 conductor 的
cgroup，而 01:0x 发现一个 orchestrator 拉起的worker pianist（orch-schedule-bone-
T153918，遥测 01:01 还在长）正改着 **未提交的 src/conductor.mjs**（schedule
骨头层，树上一堆 M/??）——pianist不在 cgroup 里，rearm 看不见它：我退役后
restart 会把导体重启进一份半写的启动码，crashloop 风险。照 09-29「晚收
不误收」的精神撤刀。**9786e41 维持未上膛**，由pianist收工后统一上膛（它的工作
树就叠在 9786e41 上，届时一次 restart 两笔齐上）。

### 发现②：上膛门禁被外网天气劫持（本班下种，见文末）

### 主活：干跑今晚唯一一发（照第四班正典：实弹前立碑）

真报告（仍冻结 09:55Z 份）+ 真状态（裁决时刻 10:00:27.796Z）直调
evaluateRetroTrigger：
- 此刻（15:22Z）：fire=false reason=none，活形状 **0/10**（全部旧账）；
- 16:00:27Z 整：不发（360=360 分钟，毫秒面 .796 未过线）；
- 16:00:28Z：fire reason=**due**，detail「抽检到期：上次复盘 360 分钟前 ≥
  间隔 360 分钟；热点 0/10 < 阈值 3」。

与第六班的碑逐字吻合。我当时照抄其钟表预测：01:00:28–01:01:35 JST 首个
心跳 tick 发车——**这个预测被实弹观察证伪了半边，见下**。

### 实弹观察：01:00 过了，发车没来——碑漏了一个结构事实（本班主收获）

01:11 醒来对账：journal 自 00:21:06 拉起我之后**一行都没有**，retro state 原封
（runs=3、lastRetroAt=10:00:27Z）。conductor 没死（PID 103524 活着、active）。
回翻 23:12–23:16 todo-review 在飞窗口：心跳同样静默——**conductor 主循环
`while(true){ await tick(); sleep(TICK_MS) }`，而 launchPart 的 Promise 只在
child close 时 resolve：活 session 阻塞整个 tick 循环，retro 心跳也住在里面**。

结构判读：
- 第六班（和我照抄的）钟表预测隐含了「心跳独立于 session 存活」——不成立。
  **due 发车时刻 = max(到期时刻, 当前 session 退役时刻)+下一 tick**，最坏延迟
  = session 时长。6h 抽检粒度下无害，但验收时刻表必须按此读。
- 干跑纯函数 ≠ 干跑系统：evaluateRetroTrigger 的碑本身全对（三时刻逐字复现），
  错的是把它直接外推成 wall-clock 预言时漏了调度器的串行结构。第四班正典
  「实弹前立碑」仍然对——碑要立在系统面上，不只函数面上。

### 退役后的预期序列（修正版时刻表，给读账者）

我退役（T）→ 旧 conductor tick 当场回填收工行 → 下一 tick（≤TICK_MS）评估：
due 早已熟 → **fire**（reason=due，detail 同我干跑的碑）。pianist收工 commit 后
由它（或下一班）挂 rearm 上膛——上膛前后 fire 语义无差（9786e41/schedule
骨头都不碰 retro 路径；retropad 现起读盘含 d81ef13）。fire 后验收（谁读到谁验）：
- `data/retro/state.json`：reason=**due**、lastRetroAt≈16:2x–16:3xZ、runs=4；
- evidence-20261012 任务书：热点行尾「裁决后新事=无」×10（d81ef13 首验）；
- 交货单台账：「心跳源=telemetry+session」（66b1139 滚动锁首验——上一发只报
  telemetry 单源正是它的修因）；
- verdict 预计 nothing（零活证据+注解「维持原判」），工单若重现应同名去重；
- restart 后 journal 冷却行应继续点名「带外 10:00:27」直到 fire；
- 报告陈旧重扫 ≈14:55 JST（09:55Z+20h），之后 threshold 源才有新弹药可计。

### 顺线（观察不追）

① **上膛门禁被外网天气劫持**（未下种，留观）：sandbox.test.mjs「先通后报」
断言过真外网——本班三跑两截，第一跑 example.net 200/example.com 000、
第二跑镜像 200/000（每次换一个域名连不通，坐实环境抖非回归）；
test/sandbox.test.mjs:256 `pass!==total → exit(1)` + package.json `&&` 链 =
单点抖动即截链，5 个下游套件根本不跑。pianist今晚跑 npm test 若遇同形状截断，
先判外网再判自己。复发两次以上建议升 thread。
② 我的遥测一度误判「没落账」：壳按 **UTC 日**命名 `${agent}-${day}.jsonl`，
JST 零点后新 session 仍写昨日文件——午夜班查账别拿错日历（本班自己就拿了）。
③ the user WIP（docs/schedule-spec-v0.1.md 未提交）在pianist树上叠着，不动。

### 下种（本图唯一一条，w=0.5，source=seed）

- **thread「rearm 第二盲区：判忙只看 conductor cgroup，看不见 orchestrator
  拉起的场外施工者——restart 可被打进半写的启动码」**（source=seed，w=0.5，
  from: 本班实录——00:29 挂 rearm 拟上膛 9786e41，01:0x 发现场外pianist
  （orch-schedule-bone-T153918）正改未提交的 src/conductor.mjs，其进程不在
  conductor cgroup（ppid 链在场外），rearm 判忙全瞎，只能亲手 stop 撤刀；
  回溯今晚 21:07 第六班那发 rearm 补刀时，dualcard pianist（21:52 才 commit）
  同样在场外半写——21:07 restart 载到的碰巧是完整码，幸运非安全）：修刀形状
  =rearm 判忙加第二判据——除 cgroup 外查 `git status --porcelain src/conductor.mjs`
  非空即按忙（树上有未提交启动码 = 有人在写，不管他在哪），或同理查
  telemetry 目录 5min 内有 orch-* 写入。判据：场外施工期间 rearm 挂着不补刀；
  施工 commit 后正常补刀。哲学同源：09-29 修的是 pgrep 看不见 cgroup 内 session，
  这次是 cgroup 看不见场外 actor——判忙的边界永远在补最后一双眼睛。

---

## 收尾笔记（第一班，≤200字）

上岗验第六班验收单：rearm 已补刀、双源钟在膛。干跑逐字复现其碑后，实弹观察
推翻了钟表半边——conductor 主循环串行 await session，活 session 阻塞心跳：
due 已熟、tick 要等我退役（修正时刻表已留账）。pianist场外半写 conductor.mjs，
我 00:29 挂的 rearm 看不见它，01:15 亲手撤刀免得 restart 打进半成品；
9786e41 留给pianist收工统一上膛。下种 1 条 w=0.5：rearm 第二盲区。
值得留的一句：**判忙的边界永远在补最后一双眼睛——cgroup 之内看 pgrep，
cgroup 之外看 git 树。**

---

## 第二班（02:03:42 上岗，空闲 30.5min 抽卡）：收获之夜——收种、排雷、上膛

### 起手：验收第一班修正时刻表——逐字兑现

- `data/retro/state.json`：reason=**due**、lastRetroAt=**2026-10-11T16:21:05.600Z**（预测
  16:2x–16:3x ✓）、runs=4 ✓、verdict=**nothing** ✓。
- journal 时序：01:18:12 fire 判定（detail「378 分钟前 ≥360；热点 0/10<3」——与第一班干跑
  碑逐字同形）→ 01:21:05 心跳收工 exit=0（173s）→ 冷却钟源切「**自家** 16:21:05.606Z」。
  发车时刻 = 第一班退役后的下一 tick——「due 发车 = max(到期, 退役)+下一 tick」的串行结构
  读法被实弹坐实，第六班的钟表碑正式翻页。
- 工单第三张落地：`pianist-bridge-tool-desc-enumerate-actions`（tool description 不枚举
  33 个合法 action，agent 全靠猜 API 面）——与开放单#1（桥未接线聚合）同族不同根因，
  非同名重复，去重逻辑无涉。三单全 open。
- 清单残项如实记：①「evidence-20261012 任务书 ×10」不可验——任务书是 retropad
  **内联**生成的，不落盘（第一班该项基于误设）；②「心跳源=telemetry+session」
  （66b1139 首验）在冻结报告（09:55Z）里 sources 仍只列 telemetry 文件——首验顺延到
  14:55 JST 陈旧重扫之后，谁读到谁验。

### 主活①：收第一班的种——rearm 第二盲区修刀（w=0.5 → 已收，4d0378f）

`deploy/rearm-conductor.sh` 判忙加第二判据 `tree_busy()`：启动码平面（src/ 全树 +
package.json）git 树有未提交改动 = 有人在写（场外pianist不进 cgroup，但 WIP 落在树上），
一律按忙；探针失败/git 缺失同样按忙（晚收不误收）。误忙代价=晚一轮补刀，漏忙代价=
restart 打进半写码。测试缝 `REARM_TREE_PROBE`/`REARM_REPO`，新增「树脏不补刀」
「探针失败按忙」两例，15/15；既有用例经 stub 与真仓 git 状态解耦（顺手拆掉
「真仓 src/ 有 WIP 时判闲用例随机翻车」的地雷）；另以一次性脏 git 仓实弹烟测默认
git 路径双向过（净树补刀/脏树按忙）。**今晚就用这把改良的刀上膛（见主活③）——
种下当天发芽当天收割。**

### 主活②：排掉一颗专坑场内修复分身的测试雷（2080d07）

全套首跑在 orch-lifecycle「挂上即转」红（22/23）。git worktree 三点 bisect：9786e41 /
d81ef13 / 83eb3ed 皆红——排除回归，环境面翻红。探针显示断的是 `inbox.size()===0`：
收件箱混入一张真「审批」事件。根因：该测与 orch-real-driver 都用
`delete process.env.PIANIST_SHELL_URL` 当隔离，但 buildRuntime 缺省**就是**
`127.0.0.1:8770`——conductor 场景真壳在场时审批轮询够得着它，真 pending 卡被拉进
测试收件箱。当晚挂着的卡恰是本班自己 touch+rm 触发的那张（ap_mv430jil_3）。
此前各班绿是因为跑时无挂卡：**环境耦合地雷，形状酷似回归，专坑 conductor 场内跑
npm test 的修复分身**（与第一班顺线①「外网天气劫持」同族：先判环境再判自己）。
修法：指死端口 127.0.0.1:1（语义不变——壳不在场照样 spawn，轮询连接拒绝出声跳过）。
修后 lifecycle 23/23、real-driver 63/63、全套 PASS、npm exit=0。

### 主活③：兑现「pianist收工后统一上膛」——本班退役后补刀

pianist已收工（277cead schedule 骨头层 + 两笔 docs），树净。本班在 2080d07 全套复验
绿后，按头注正典挂 rearm 清道夫（systemd-run --collect）：判闲=cgroup 只剩主进程
**且启动码树净**（tree_busy 首战实战）→ 补刀 restart。载入面：9786e41（env-event
血源本地优先 + tideline-threads）+ 277cead（schedule 骨头）+ 本班两笔。上膛前后
retro 语义无差（state.json 在盘，冷却钟跨重启续走）。

### 退役后验收单（给读账者）

- rearm journal：正常判闲两读 → 补刀 restart（树净，不应见「启动码树未提交」行；
  若见了，说明有人在半写——那是新判据在干活，别手动 restart）；
- conductor PID 换新、`--status` 或 journal 首个 tick 出现 `schedule 判定：due=0 …
  （条目 0 张，活动窗 10:00-22:00@北京 src=file·窗外）`——entries 空、窗外，纯出声
  无行为，schedule 骨头层上膛即视；
- 冷却行继续点名「自家 16:21:05」；下一 retro due ≈ 22:21:05Z（07:21 JST）；
- 14:55 JST 前后报告陈旧重扫（09:55Z+20h）→ 验 66b1139「心跳源=telemetry+session」；
- 审批卡 ap_mv430jil_3（本班 touch+rm 烟测被红区闸拦，已换安全做法：一次性脏 git
  仓）仍在 pending——对裁决者：该命令已废弃，拒了无副作用。

### 下种

零新种。本班是收获班：第一班的种当天收；排掉的雷属于既有线的加固，不值得再开线。

---

## 收尾笔记（第二班，≤200字）

上岗验第一班修正时刻表：逐字兑现（due 16:21:05、runs=4、nothing，冷却源切自家）。
主活三件：收种——rearm 判忙加 tree_busy 第二判据（git 树非净即忙，场外半写者
逃不进 restart）；排雷——orch 测试 `delete env` 假隔离，真壳审批卡拉红全套，
三点 bisect 定环境非回归，指死端口修复；上膛——全套复验绿后挂改良 rearm，退役后
补刀载入 9786e41+277cead。零新种。
值得留的一句：**delete 环境变量不等于隔离——缺省会把真系统请回来；测试的墙要
砌在缺省够不着的地方。**
