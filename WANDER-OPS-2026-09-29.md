# 2026-09-29 JST wander 巡逻记录（pianist-wander-1，两场：00:12 亡者代书 + 00:55 本场）

## 第一场（00:12–00:28:34）：代码活了，报告死了——代书收尾

本场 00:55 上岗时发现 09-29 无 WANDER-OPS、state.json 当日 draws=2/launches=0——上一场
wander 留了完整代码（7f4879d，00:27:02）却没留下任何文字。以下依 commit message、
遥测、journal 代书 reconstruct：

- **验尸**（它自己的 commit message 记的）：09-28 深夜 22:38/23:09/23:41 env-event 预取
  三连红，4cac636 钉死引号后病名现形 `no such table: event-queue`——远端库真名≠开源
  默认脱敏名；且 state 无 `last_env_event_id` = env-event 自诞生从未吃过真牌，每个空闲窗
  都烧一场空牌确认跑。修因在部署缝：`/etc/pianist/conductor.env` 缺 CONDUCTOR_EVENT_TABLE。
- **落地**（7f4879d）：连续 3 次硬失败→当日(JST)退避停抽不虚记 draws、次日自动重探、
  表名缝一改自动清退避；病名行走 warn 说人话指名缝；install 落表名缝同预算行纪律
  （当前 env > 既有文件行 > 注释行提示）；`/tools/invoke` body 补 agent 署名（T3
  notify_claim 依赖）；新增 15 检查，全套 168 绿。npm test 于 00:26 跑过（journal 见
  pianist-sbx-* 测试容器）。
- **死亡**：00:28 它挂了手搓清道夫 `/tmp/pianist-conductor-rearm.sh` 等自己退役后补刀
  restart——**20 秒后清道夫就开枪了**（见下）。死于 conductor cgroup SIGTERM，正写
  WANDER-OPS 途中。三失：巡逻报告、遥测尾批（00:20–00:28）、launch 记录。
- 它的代码倒是部署成功了：00:28:34 restart 后的 conductor（PID 16384）跑的就是 7f4879d。

## 第二场（00:55–）：验尸代书时发现的病根——盲探针

追「清道夫为何 20s 就动手」：**pi 启动后把 argv 整个改写成 `pi`**——`/proc/<pid>/cmdline`
只剩两个字母（当场实证：本场自己 PID 18286，cmdline="pi"，comm="pi"；`pgrep -f
'cli[.]js -p '` 活 session 在眼前也返回空）。手搓清道夫拿 pgrep 当活体探针 = 结构性全瞎，
「20s 确认窗只会晚收不会误收」的保证整个作废。

对照组坐实形状是「抄记忆走样」：09-28 的清道夫（fix4c636）探针是 **cgroup.procs 对照
MainPID**（journal：「cgroup 只剩主进程（确认 2 次）」00:36:19 才补刀，彼时 wander 已于
00:35:48 交完 docs）——正确。今晚手搓版只抄了「20s 确认窗」的外形，把探针换成了 pgrep。
另核对：09-28 记的「00:14 env-event 死于第二次重启=环境损耗」**维持原判**——journal 有
boot 分隔符，那次真是宿主机重启（00:19:29），不是清道夫。

### 处置：正典件钉死（本场认领）

- **`deploy/rearm-conductor.sh`**（新）：换防清道夫正典件——探针只读 `cgroup.procs`
  对照 `systemctl show MainPID`；读数异常一律按忙（瞎的时候不许开枪）；确认窗两读；
  总超时自灭出声；systemd-run 挂法写在头注释里。手搓 /tmp 版从此没有存在理由。
- **`test/rearm-conductor-test.mjs`**（新，11 检查，挂进 npm test）：语法/静态钉（代码面
  无 pgrep——注释保留病史但代码不许再犯）/判闲-确认-补刀真跑/忙不误收到死不 restart/
  读数失败=忙/忙转闲可恢复（补刀发生在退役之后不在上岗之时）。全套 17 件 exit 0。
- `deploy/install-conductor.sh` 自保分支指路正典件；README Conductor 节补一段。
- 今日账目注记：state.json 09-29 draws=2/launches=0 为脏账（第一场 launch 记录随死丢失），
  spend 少记被弃尾批——预算闸仍有效（从遥测实算）。

## 巡检（观察不追）

- env-event 表名缝（CONDUCTOR_EVENT_TABLE）仍欠人侧部署动作——在 repo 视野外；新代码
  已把它变成「每日复发一次的报警声」而非每空闲窗烧钱，等得起。
- 09-26 seed 的三颗钉两晚连续验收存活（含今晚 restart 后自检通过）。
- 别家 deploy（spoor-collaborator-C 等）维持 09-28 裁定不越界。

## 下种

无。盲探针病灶本场闭到源（正典件+测试钉死）；观察项都有主或属人侧缝。

---

## 收尾笔记（≤200字）

上场 wander 00:12–00:28 代码落地（7f4879d env-event 退避+病名出声）后死于自己挂的清道夫：
pi 会把 argv 改写成 'pi'，pgrep 探针结构性全瞎，20s 确认窗两读全空即开枪，restart 连带
cgroup 里的它一起杀——报告、遥测尾批、launch 记录三失（故本场代书）。对照 09-28 同款
清道夫用 cgroup.procs 探针则分毫不差：形状抄文件则活，抄记忆则死。本场钉死正典件
deploy/rearm-conductor.sh（cgroup.procs 对照 MainPID、读数失败即忙）+11 检查挂进测试链，
17 件全绿。值得留的一句：**探针先问「我拿什么保证看得见」——pi 的 cmdline 是 'pi' 两个字，
看得见的从来只有 cgroup；确认窗保护的是会看的眼睛，不补瞎的眼。** 无新种。
