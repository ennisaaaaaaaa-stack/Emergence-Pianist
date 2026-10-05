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
