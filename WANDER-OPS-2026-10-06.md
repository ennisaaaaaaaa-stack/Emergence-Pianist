# 2026-10-06 JST wander 巡逻记录（pianist-wander-1，02:28 上岗）

## 第一班（02:28 上岗）：桥通了——但只有一张脸是活的

### 起手：追最新鲜的痕迹

上岗前 9 分钟仓库里发生了本月最热闹的 20 分钟：02:07 有人拉起 8791 的 spoor workbench
实例（0.0.0.0，注释写明 WSL NAT 给 Windows 侧用）、02:17:54 作者起 SSH 隧道把远端
grimoire 穿透到 127.0.0.1:8730（pid 59336，`-L` 只有这一个口）、02:17–02:21 三场
wiretest 分身跑完——wiretest-3 调 `pianist_bridge::grimoire_map` 成功（4341B）。wiretest
不进 state.json（手动拉起，不走 conductor），但 telemetry 留了影：**桥接线了**。

### 验桥：三个动作，两种命运（全落本班遥测）

- `grimoire_map`：✅ status 200，与开场注入的经图逐字一致——读面信封是数据不是失败。
- `grimoire_skill{id:spoor-project-lifecycle}`：✅ 200——带参路由（`{id}` 展开）同绿。
- `spoor_status` / `spoor_list`：❌ **HTTP 502**——壳自己的 `/tools/invoke` 回的（extension
  throw「软错不软抛」，isError 落账）。

### 病根：spoor 面路由到不存在的提供者

证据链五环：

1. 壳 `TOOL_ROUTES` 把 spoor_* 指到 `127.0.0.1:8793/8794/8795`（一住户一署名，pianist
   从 8793 起）。
2. `ss -tln`：三口**零监听**（curl 连接拒绝）；8730 有隧道、8770 有 systemd 壳、8791 是
   别的住户的实例（python pid 222，02:07 起）。
3. `pianist-shell.service` unit 无 `SPOOR_*_URL` 覆盖——线上壳用的就是默认三口。
4. 三实例唯一的拉起者是 `start-pianist.sh` 的 `spoor_up`——**WSL 交互启动器**，非部署
   形态；systemd 只正典化了壳（unit 注释自带先例：壳 09-26 前也是 transient 重启即蒸发）。
5. 本地要件齐全：`~/session-spoor` 源码、`~/spoor-venv`、`~/Stigmergy`（活的，ledger
   此刻还在被别的活动写）——不是「跑不了」，是「没人负责拉」。

结论：**部署形态从 start-pianist.sh 迁到 systemd+隧道时，grimoire 和壳都过了河，
spoor 三实例留在了岸上。** 历史上 21 次 `spoor_status` 错是「未接线」形状；桥通后它们
会换成 502 形状继续错（本班两发探针已把该 shape 的 lastTs 刷新到今天——下份热点报告
自会作证）。

### 为什么不动手

- 作者正施工中（02:07–02:22 连续落子），代跑有撞车风险。
- 拓扑是真裁定不是机械修：本地 systemd 三实例 / 隧道扩三个口 / 指向 8791 共根实例，
  三条路都通，选哪条是部署决策（同 10-05 游标起点案：证据钉死，拍板留人）。
- 技能正文自带「孤儿进程陷阱」警告——从 session 里拉的长驻服务会变 root 孤儿，作者
  还得收养/击杀，帮倒忙。

### 巡检（观察不追）

- **第六班心跳预言兑现**：22:56:11 wander 退役 → 22:57:17 首 tick 开火「报告陈旧 →
  扫描器上膛 → 109ms 落盘」，journal 三行与 latest.json mtime 同秒，逐字对上可证伪
  预言。观察点闭。
- 昨日文件里的「第七班」收尾笔记实为 env-event 分身所写（telemetry 15:34Z：
  pianist-env-event-1 读 WANDER-OPS、grep 收尾笔记、追加成功）——env-event 不是
  wander 班，班次记号有身份串线；内容无害，一句认领，不动。
- 今日 env-event 02:15 照旧单 message_end 空牌（结构性哑僵尸，10-05 第四班种子 w=0.5
  仍待作者拍板游标起点）。
- 预算：昨日 $2.61/$20；本班数发探针，无压力。

### 下种（本图唯一一条，w=0.5，source=seed）

- **thread「桥 spoor 面无提供者：三实例 8793-8795 零部署路径——systemd 只正典化了壳，
  start-pianist.sh 的 spoor_up 是唯一拉起者且为 WSL 交互形态；grimoire 走了隧道它没
  跟上」**（source=seed，w=0.5，from: TOOL_ROUTES 默认口零监听 + unit 无 SPOOR 覆盖 +
  五环证据链）：修刀形状=三选一拓扑裁定（本地 systemd 三单元 / 隧道扩 -L 8793-8795 /
  SPOOR_WORKBENCH_URL 指向 8791 共根实例），跨部署界约，作者拍板后一班可闭。判据：
  任一 spoor_* 桥调用返回 200 信封即闭线。

---

## 收尾笔记（第一班，≤200字）

上岗前 9 分钟桥刚接通（wiretest 02:19）。首验三动作：grimoire 两路由绿（含带参路由），
spoor 面 502——壳路由 8793-8795 本地零监听。部署缝验尸：systemd 只正典化了壳，spoor
三实例唯一拉起者还是 WSL 交互启动器；grimoire 走了隧道、它留在了岸上。作者正施工，
证据钉死、拓扑裁定留人，下种 1 条 w=0.5。顺手闭了第六班心跳预言（22:57 逐字兑现）。
值得留的一句：**桥通了不等于线通了——验收要逐面打真牌，第一个绿掉的面最会替还没验的面说谎。**

---

## 第二班（03:26 上岗）：种子的证据链少了一环——systemd 里其实有 spoor 实例的活模板

### 起手：接种子，先问「作者落子了吗」

第一班种子是「桥 spoor 面无提供者：三实例 8793-8795 零部署路径」。上岗先验裁定落没
落：`ss -tln` 三口仍零监听；壳 unit 仍无 `SPOOR_*` 覆盖；桥面实弹各一发——`grimoire_map`
200（绿面仍绿）、`spoor_status` 502（病面仍是病面）。裁定未落。但顺着 8791 那个活实例
查归属，撞出了第一班五环链的漏环。

### 修正：systemd 不是「只正典化了壳」

`/etc/systemd/system/spoor-mingming.service`——**enabled、Restart=on-failure、活了 11h+**
（为另一住户「mingming」开的 workbench，8791）。它 `ExecStart=/root/spoor-http-service.sh
mingming 8791`：一个通用模板脚本，收「住户名+端口」，设 `SPOOR_AGENT=<住户>` 区分数据。
第一班写「三实例唯一的拉起者是 start-pianist.sh 的 spoor_up（WSL 交互形态）」——
不全对：**spoor HTTP 实例的 systemd 正典化先例已经在库**，只是 pianist 自己的三模块
没跟上。另修一处钟：8791 的 pid 222 起于 10-05 17:11:34（unit Active since 16:15:47），
不是第一班记的「02:07 起」——02:07 大概率是作者**发现/访问**它的时刻（02:16:03 它的
journal 里有 POST /mcp 202），拉起与撞见是两件事。

### 裁定收紧：三选一变二选一

- **选项三（指向 8791 共根）基本可排除**：模板靠 `SPOOR_AGENT` 绑住户数据，pianist 指
  向mingming的实例等于把署名写进别人名下——除非刻意共享，多住户署名边界即否决票。
- **选项一（本地 systemd 三单元）成本大降**：不再是「发明部署形态」，是照 spoor-mingming
  抄三份。唯二改刀点：模板脚本 hardcode `workbench_server`（pianist 还要 archive/
  scratchpad，需加模块参数或专用脚本）；绑定面模板是 0.0.0.0（WSL NAT 需求），pianist
  的 spoor_up 原来绑 127.0.0.1——绑哪面是部署决策，跟端口表 8791-8795 的住户协调
  一起留给作者。
- 选项二（隧道扩 -L 8793-8795）不动如山，仍待比价。

### 巡检（观察不追）

- conductor 02:35:01 被作者 stop（SIGTERM 干净退出），静默 51min 后 03:26:40 重启，
  我即重启首抽；02:20-02:35 的「忙，不拉」日志对应作者施工尾段。
- git log 三新提交（f495d85/2b1b1b0/03b12e1）全是 sandbox fixture 修补，没碰部署面。
- 热点报告（10-05 13:57Z）里 spoor_status 形状 lastTs 仍是 10-03——第一班的「下份
  报告自会作证」要等 20h 心跳窗，预言未到期。
- 今日 $0.73/$20（我上场前），无压力。

### 下种：零新种

第一班种子（w=0.5，source=seed）原样前传，本班只钉脚注：**systemd spoor 实例正典化
模板已在库（spoor-mingming + spoor-http-service.sh），裁定从三选一收紧为二选一，首选
路径照抄可成**。判据不变：任一 spoor_* 桥调用 200 即闭线。

---

## 收尾笔记（第二班，≤200字）

接第一班种子验裁定：未落，502 面仍是 502。但五环链有漏环——`spoor-mingming.service`
（enabled）证明 systemd 里 spoor HTTP 实例的正典化先例活着，pianist 三模块只是没照抄。
共根 8791 路线被住户署名边界否决，三选一收紧为二选一。顺修一处钟：8791 实例起于昨日
17:11，非「02:07 拉」——拉起与撞见是两件事。值得留的一句：**说「零部署路径」之前，
先看同类的部署路径有没有先例——多数「没人负责」其实是「模板在库、拷贝未发生」。**

---


## 第三班（04:00 上岗）：两个拉起器各握一半答案——选项一成本钉死成「两行 diff」

### 起手：裁定落了吗

未落。四验：`ss -tln` 8793-8795 仍零监听（在跑的只有 8730 隧道/8770 壳/8791 mingming）；
`/etc/systemd/system/` 无 spoor-pianist*；壳 unit 仍无 `SPOOR_*` 覆盖；桥面实弹——
`spoor_status` 502（病面照旧）、`grimoire_map` 200（绿面不回头）。作者最后一手是
03:18-03:19 两个 sandbox fixture 提交（第二班已见的三连发尾段），此后静默。

### 新钉一环：亲手读两个拉起器，发现它们互补

第二班钉的是「模板在库」，本班把两个拉起器都读全了，撞出一个形状：**两个半成品各握
一半答案**。

- `spoor-http-service.sh`（mingming unit 的 ExecStart）：收 `(住户名, 端口)` 两参、
  `SPOOR_AGENT` 署名、systemd 正典化——但 `import workbench_server` 写死，模块无参。
- `start-pianist.sh` 的 `spoor_up`：收 `(模块, 端口)` 两参、三模块全拉（8793-8795）
  ——但 agent 写死 pianist、绑 127.0.0.1、且是 WSL 交互形态，无正典化。

并集 = 给模板脚本加可选第三参（模块名，默认 `workbench_server`——mingming unit 一字不用
改，向后兼容），再照 spoor-mingming 抄三份 unit，ExecStart 传
`(pianist, workbench_server|archive_server|scratchpad_server, 8793|8794|8795)`。
源码侧三模块齐全（`/root/session-spoor/` 里三个 `*_server.py` 都在），venv、Stigmergy
根也都活着。**选项一从「照抄可成」钉死为「一处两行 diff＋三份拷贝」，真决策只剩两个：
绑定面（模板 0.0.0.0 的 WSL NAT 理由 vs pianist 史上 127.0.0.1 纯本地）和端口表协调。**

### 学理锚点：这不是孤案，是本宅第一伤口的活标本

README L85（心跳设计注记）自陈家规：「deployment seams are this house's top
recurring wound」——当时为避免第三份 unit+timer 特意把心跳骑在 conductor 身上。spoor
三实例正是这伤口的活标本：部署形态迁移（start-pianist.sh → systemd+隧道）时，过了河
的是壳和 grimoire，留在岸上的是 spoor。作者拍板时可以引用自家先例与先例里的反面教训，
不必从零论证。

### 巡检（观察不追）

- 我即 18:59:45Z（03:59 JST）抽签——cred-journal 最后一行就是我自己上岗领钥匙
  （use-vault coding-plan），此前作者侧无新痕迹。
- Stigmergy 根 03:29 仍在被写（别户活动），非 pianist 面的生态活着。
- 热点报告仍停在 10-05 13:57Z（22:57 JST），20h 心跳窗下一次扫描约 09:57 JST——
  第一班「502 形状将刷进下份报告」的预言仍在窗内，本班不可裁。
- 预算：今日 $0.89/$20（8 抽，含我在内），无压力。

### 下种：零新种

第一班种子（w=0.5，source=seed）原样前传，本班钉脚注之二：**选项一实施成本已钉死
（模板脚本两行 diff＋三份 unit 拷贝，mingming unit 零改动），真决策收缩为绑定面＋端口表
协调两件事；且 README L85 自陈「部署缝是本宅头号复发伤口」，此案即其活标本。**判据
不变：任一 spoor_* 桥调用返回 200 信封即闭线。

---

## 收尾笔记（第三班，≤200字）

接两班种子验裁定未落——8793-8795 零监听，spoor_status 仍 502、绿面仍绿。新钉一环：
模板脚本收(住户,端口)却写死模块，spoor_up 收(模块,端口)却无正典化——两半互补，
并集＝两行diff＋三份拷贝，真决策只剩绑定面与端口协调。值得留的一句：**巡逻不修
东西时，最好的产出是把待决问题压到只剩真问题——「发明部署形态」成了「两行diff
＋一个绑定面」，剩下的才配叫决策。**

---


## 第四班（16:52 上岗，重启后首抽）：裁定落了，重启替我们跑了验收——种子闭线

### 起手：12.8h 空窗后接管

第三班 04:02 收尾后仓库静默；机器 16:46 整机重启，conductor 16:51 常驻启动、
journal 自陈「空闲 769.0min > 30min → 抽卡：wander」——我即重启后首抽。

### 裁定已落：04:07，且比第二/三班的处方更省

`/etc/systemd/system/pianist-spoor-{workbench,archive,scratchpad}.service` 三份
unit，mtime **04:07:10——第三班收尾（04:02）后 5 分钟**施工。形态与两班处方同路
但更省刀：不扩模板脚本第三参，每份 unit 内联 `python -c` 直 import 对应模块并设
host/port；`SPOOR_AGENT=pianist`、`Restart=on-failure`、**enabled**；绑定面选了
**127.0.0.1**（pianist 史上纯本地立场，未抄mingming的 0.0.0.0 WSL NAT）；端口表
8793/8794/8795 与 8791 mingming共存无冲突。共享模板脚本零改动，mingming unit 零波及。

### 重启即集成测试（免费且不自知）

三 unit 全部 `ActiveEnterTimestamp=16:46:43`——enabled 的部署形态在整机重启时
全部干净自启，boot 持久性被一次意外重启当场验证。systemd 正典化的下半场（重启
还在）不用再等下一次了。

### 桥面实弹：读、写双绿，闭线判据达成

- 首发探针 `spoor_status` 空参：回 **pydantic 校验错**（`project` Field required）——
  **不是 502**。连接拒绝的死面不会跟你讨论参数；这是 8793 活体在说话。
- 补参 `spoor_status{project:portalk}`：**200 信封、`isError:false`**，满载 STATUS/facts。
- 加验写面 `spoor_journal{mark:数据}`：`ok:true, agent:pianist`；ledger.jsonl 尾行
  `threesome.journal.write (pianist)` 逐字对上——session→桥→壳8770→8793→Stigmergy
  全链贯通。顺手清了「journal 13h 未写」的 nudge（此前最后一条是作者 03:35）。

第一班种子判据「任一 spoor_* 桥调用返回 200 信封」达成且超额（判据只要读，本班
把写也验了）。**种子闭线撤档。**

### 巡检（观察不追）

- 诚实账：首发空参探针 isError:true 会以 spoor_status 错形落遥测——下份热点报告
  里它是**调用方缺参的 4xx 形**，不是 502 回潮，下任别误读为回归。
- 热点报告仍停 10-05 22:57（18h 陈旧）；tick 在 session 期间停摆（10-05 第六班
  已证），我退役后应补火——**预言：下份报告里 spoor_status 形状应现 502→2xx 迁移**。
- git 无新提交（末笔 03:19）；今日 $1.05/$20，无压力。
- 脚注（非种）：三 unit 仅存 /etc，repo `deploy/` 只收录 conductor+shell 两 unit、
  install-conductor.sh 无 spoor 面——机器若从仓重建，spoor 面会无声复活成 502。
  是否入库随作者，README L85 的「部署缝头号伤口」家规下值得一句自陈。

### 下种：零新种

第一班种子闭线，图上无在途线。deploy/ 收录脚注不升格为种——作者刚亲手施工完，
把脚注留在记录里即可，别给刚收口的缝再压一层跟踪债。

---

## 收尾笔记（第四班，≤200字）

重启后首抽（16:52）。裁定在第三班收尾后 5 分钟落地（04:07）：三份自足 unit、
内联 python -c、绑 127.0.0.1、enabled——比两班处方更省，模板零改动。16:46 整机
重启意外当了集成测试，三口随启。桥面实弹：spoor_status 补参后 200 信封、
spoor_journal 写入账本见 (pianist) 署名——读面写面双绿，第一班种子闭线撤档，
零新种。值得留的一句：**enabled 的部署形态，第一次意外重启就免费替你跑了恢复
演练——巡逻者的活，是去看它起没起。**
