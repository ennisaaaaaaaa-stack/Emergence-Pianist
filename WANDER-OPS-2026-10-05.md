# 2026-10-05 JST wander 巡逻记录（pianist-wander-1，04:45 上岗）

## 第二班（05:20 上岗）：上一班的修复自噬了——行内注释吞进表名

### 起手：接昨班留的观察点，先撞见一个真雷

04:50 补刀 restart 如约打响，05:20:20 退避缝自清判据如期触发（`event-queue → event-queue…`）
后抽中我。本想只看首场真牌面，但跑预取测试时正组全红「预取失败降级」——验尸发现
`/etc/pianist/conductor.env` 那行写的是：

```
CONDUCTOR_EVENT_TABLE=event-queue  # 2026-10-05 wander：远端实表已验（…）
```

systemd EnvironmentFile **不剥行内注释**——`#` 后整段进了表名，SQL 变成
`FROM "event-queue  # 2026-10-05…"`，下一场 env-event 必死 `no such table`，fail_streak
重新爬，十天僵尸环多活一天。昨班验的是裸 SQL rc=0，没验 env 值绕一圈后的真身——
注释写对了地方、写错了文件格式。

### 三刀

1. **部署侧**：env 文件注释挪独立行（sed -i 保 600），真 systemd 解析器实读回
   `[event-queue]` 干净值；rearm transient unit 挂起等我退役补刀 restart。
2. **代码侧**：`eventTable()` 值形状先验——带空白/# 即病名出声，修法点名「注释挪
   独立行」，把「写歪」和「没写」分开喊（fetch 侧旧修因行会误导）。1dce9b6。
3. **测试侧**：预取测试 +2 钉：真名（无横杠 event-queue）注入全链路活；病形状值
   病名行必出声。11/11，backoff 15/15，selfcheck/rearm/ledger/heartbeat 无涟漪。

### 附带发现：分身测分身的污染

预取测试首跑全红其实是**环境污染**：我这个 shell 是带着坏值的 conductor 的子孙，
`spawnSync({...process.env})` 把 `CONDUCTOR_EVENT_TABLE` 一路传给了被测进程。
`env -u` 剥干净后 8/8 绿。教训入账：在 session 里跑 conductor 测试，先剥
`CONDUCTOR_*` 继承——不然测的是自己父辈的伤。

### 巡检（观察不追）

- restart 后首条日志正典自检+版本门正常；T15b（钥匙柜×沙箱接缝）已提交，未动表名缝。
- `last_env_event_id` 仍 null→0：`LIMIT 5`+`replay_day IS NULL` 保底，不会灌牌。

### 下种：零新种

观察点不变：restart 后首场 env-event 真牌面（event-queue 消费）仍是天然收尾延伸。

---

## 收尾笔记（≤200字）

追昨班的尾巴撞见真雷：env 值把行内注释整段吞进表名，修复自噬。三刀闭环：env 文件
注释独立成行（真 systemd 解析器验回 event-queue）、eventTable() 值形状病名出声、测试
钉真名注入+病形状。附带教训：session 里测 conductor 要先剥 CONDUCTOR_* 继承——
分身测分身，测到的常是父辈的伤。值得留的一句：**写对地方写错格式的修复，和没修
一样；部署缝上的每个值，都得用它真正的解析器读回来一遍。**

## 起手：追一个数字

state 里 `env_event_fail_streak` 从 10-04 报告的 4 爬到 **6**，退避日正是今天；最近两场
env-event 遥测各只剩 **一行** message_end（~2.4k tokens，零工具调用，exit 0）——降级空牌
确认跑的僵尸形状，每场烧几千 token 重新发现同一个已知事实。病名行从 09-25 起天天打在
journal 里：`no such table: event-queue`，修法也天天写着：env 写 `CONDUCTOR_EVENT_TABLE=
<真表名>`。十 天没人动——因为没人知道真表名。

## 病根：修因卡在一个没人去看的事实上

预取链路是 `ssh the-remote sqlite3 ~/memory/mcp_memory.db`。今天干的事就是去看：`.tables` 列出
33 张表，无 event-queue；逐张对形状（id/thread_id/cosine/signal_text/signal_source/
logged_at/replay_day），命中 **event-queue**（signal_source 默认 'user_message'，mode 默认
'shadow'——§九唤起日志的正身）。表是活的：9549 行（09-24 起），日均 50~110 条被 replay，
此刻 pending=0 只是当日已清账。conductor 的 `last_env_event_id` 尚未开张（null→0），接上后
从明日新行起消费。

修法全按系统自己开的方子：`/etc/pianist/conductor.env` 落
`CONDUCTOR_EVENT_TABLE=event-queue`（600 保持），rearm-conductor.sh 挂 transient unit 等我
退役后补刀 restart——restart 后首 tick 的缝变判据（backoff_table=event-queue ≠
TABLE_NOW=event-queue）自动清退避重探。三件过往工程在这一刻合龙：09-29 的退避缝自清、09-29
的安装器表名行保全（重装不蒸发）、09-26/28/29 血史磨出的 rearm 换防（cgroup.procs 判闲，
不误收）。双层 shell 引号的原始 SQL 按 conductor 原样实跑 rc=0——引号钉（09-28）也复验过。

## 巡检（观察不追）

- 今晨首场 spoor-session 02:47 死于 `parent-down`（宿主 reboot），T7 死因入账按设计工作。
- 作者 04:37 落 T15：key 供给改走钥匙柜（cred-journal 满屏 use-vault）。T15 没碰表名缝，
  与本场修复正交；且 env 重写保全逻辑保证 T15 重装也不冲掉 event-queue 行。
- ③线收敛门本体（同型异辞归一）仍开，本场不动它。
- errorHotspots 无新形状：wander 昨场的 pianist-tools.ts 三连 edit 已随 aafea23 提交。

## 下种：零新种

env-event 复活后首场真牌面（有事件的 event-queue 消费）是天然的下一观察点，不开新 thread——
它就是本场的收尾延伸，留给明天的自己撞见即可。

---

## 收尾笔记（≤200字）

追 fail_streak 4→6 的僵尸环：env-event 十天每天降级空牌，修因「写真表名」天天打在
journal 里却没人知道表名。今天 ssh 去远端看了一眼：`.tables` 里没有 event-queue，形状
逐列命中的是 event-queue（9549 行，日均 50+ 条，活的）。env 落表名、rearm 挂好等我退役补刀
restart，退避缝明日自清。值得留的一句：**修因写在日志里十年也没用——修复卡住时，先问
「这个事实谁去看过」，多数死结只是没人去看的那一眼。**

---

## 第三班（16:51 上岗）：验收昨刀——修复活着，只欠抽中

### 起手：接观察点，先查为什么 env-event 还没来

昨班留的观察点是「restart 后首场 env-event 真牌面」。到上岗时一场都没发生——先排除
阻塞，再下结论。时间线（journal 验尸）：05:26 rearm 补刀 restart 生效 → **05:53 宿主
关机，一睡 10 小时** → 16:08 醒来，16:13 首场 spoor-session 起跑 20 秒被第二次 reboot
杀掉（parent-down，死因入账按设计工作）→ 16:15 todo-review → 16:51 我。醒来后仅 3 抽，
env-event 只是没轮到，**不阻塞、在池子里等**。

### 验收：比昨班更深一层的读回

昨班教训是「部署缝上的值要用真解析器读回」。今天再往下一层：直接读 live 进程
`/proc/212/environ` → `CONDUCTOR_EVENT_TABLE=event-queue` 干净值。链路 env 文件→systemd
解析→进程环境，三环全绿。附带一喜：05:44 env 文件被外部重写过一次（mtime 为证，
重写者是宿主上的非 conductor 活动，内容未看未引——纪律），表名行**活过了这次不约而同
的重写**——09-29 落的安装器表名行保全，头一次被真实重装修炼。

### 两笔当场了结的小账

- 疑「days 计数 9/9 vs launches 数组对不上」——肉眼数错，node 数回 9/9 严丝合缝，97 行
  <200 封顶无裁剪。假警报，清。
- `last_env_event_id` 在 state.json 缺席不是病：它只在成功消费后写入（line 717），史上
  从无一场 env-event 成功过。缺席即证词。首场成功时 `?? 0` 起步 + LIMIT 5 + 吃满出声
  的积压告警全在位。

### 巡检（观察不追）

- 双 boot 各打一次「牌面迁移 T101·T102·T103 3 条旧格式→v0.9」——虚拟迁移每次重算
  是设计；但背后是 spoor-session 连吃两次 reboot 没跑完，v0.9 改写一直落不了地。reboot
  频率是宿主侧的事，不追。
- 热点报告无新形状（spoor_status 21x、retropad 测试 12x 均为旧工具频次热点）。

### 下种：零新种

观察点原样前传：首场真牌面（env-event 抽中、events>0、last_env_event_id 开张）。它是
本线自然收尾，不是新 thread。

---

## 收尾笔记（≤200字）

验收昨刀：live 进程 /proc/212/environ 读回 event-queue 干净值，三环全绿；表名行活过了
05:44 一次外部 env 重写——09-29 的保全逻辑首次实战。env-event 未到只因宿主睡了 10 小时、
醒来仅 3 抽，不阻塞。顺手清两笔小账：days 计数对得上（肉眼数错）；last_env_event_id
缺席即证词——史上无一场 env-event 成功过。值得留的一句：**验收修复时，比修的地方再
往深读一层——昨验 env 文件，今验进程环境；每深一层，就少一种「以为修好了」。**
