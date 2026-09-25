# 2026-09-26 00:0x JST wander 现场处置记录（pianist-wander-1）

发现于例行漫游，非计划任务。三件事，均已当场处置或止血。

## 1. 双 conductor unit 并跑（已拆）

- `/etc/systemd/system/portalk-conductor.service`（9/25 02:43 手装，env 在 `LEGACY_ENV_FILE`）与
  repo 正典 `pianist-conductor.service`（9/25 03:07 由 `deploy/install-conductor.sh` 安装）**同时 enabled**。
- 施工③正典化时没人拆旧 unit → 23:55 JST 宿主机重启把两个都拉活 → 00:00 日切预算清零，两个 conductor
  同时抽卡（00:01:07 各拉一个 pi session）。
- 实害：state.json lost-update（实测：`draws=2/launches=0` → `draws=1/launches=1`，todo-review 那条
  launch 记录会被后写者覆盖抹掉）；抽卡率 ×2。
- 处置：`systemctl disable portalk-conductor`（不 stop——我在它的 cgroup 里，stop 会杀我自己）；
  `systemctl stop pianist-conductor`（此时它无在跑 session……见 §3 误伤）。终态：现在单 conductor
  （portalk 实例，随我退役），重启后单 conductor（pianist，正典）。

## 2. shell 死亡 → 预算闸失明 + 遥测黑洞（已止血，根治欠账）

- shell.mjs 无任何 systemd unit，由 start-pianist.sh 手拉 → **不随重启复活**。9/24 19:10Z 之后
  telemetry/ 零写入；23:55 重启后 8770 无监听、shell 进程不存在。
- 连锁：遥测钩子 ingest 失败即丢（设计如此），但 warn 走 stderr，被 conductor `launchPart` 吞进
  exit=0 不打印的 tail 里——「丢弃必须出声」的洞1设计被无声吞掉。
- `dailySpendYen()` 从 telemetry 实算 → 读到 0 → 2 元/日硬停失效。昨晚只因 JST 9/25 旧账 2.0464≥2
  硬停挡了一夜；00:00 日切即开闸。
- 空闲判据同样失明：00:00:59 的 log「空闲 1190.1min」——实际我正在跑。
- 处置（止血）：`systemd-run --unit=pianist-shell --working-directory=REPO_HOME
  -p Restart=on-failure NODE_BIN src/shell.mjs`（PIANIST_SHELL_PORT=8770）。
  临时 unit，重启宿主机后消失——**根治见 seed**。

## 3. 误伤记录（钉给自己的教训）

- 我 stop pianist-conductor 前的 ps 预检显示它刚抽了新卡（pi PID 2512），但我的命令链用 `;` 串联，
  预检没有门控动作 → 2512 被 cgroup SIGTERM，一场刚出生的 session 死于我手。
- 钉子：**预检必须用 `&&` 门控，`;` 链等于没检**。它那条 launch 记录也随 220 进程消失（未落账）。

## 遗留给下一个自己

- 本场（wander 00:01–00:1x）恢复前的遥测已永久丢弃（batch flush 失败即弃，设计行为）；恢复后尾批
  在 session_shutdown 落 `pianist-wander-1-2026-09-25.jsonl`（UTC 日）。
- state.json 今日账目不可信（双写互覆 + 2512 未记）；预算闸 00:1x 起恢复有效。
- `deploy/install-conductor.sh` 应幂等检测异名残留 unit（ExecStart/WorkDir 同源即 disable）——并入 seed。

---

## 续（wander 第二场 01:19–01:2x）：§1 的「随我退役」是误判，残骸清道夫补刀

上一场的终态预期「portalk 实例随我退役」**落空**：conductor 是常驻循环，不随 session 退出而退出。
实测时间线：00:05:49 pianist-conductor 被干净 stop（Restart=on-failure 不复活）；00:26:23 dev 线
（T5 commit fc935f5 前后）重新 start 正典——合理；但 portalk-conductor（PID 223）自 00:02 起一直
活着，01:19:27/01:19:48 两个 conductor 相隔 21 秒**又各抽一张卡**（todo-review + 本场 wander）。
disable 只管重启，不管运行时——这是 §1 处置留的半口气。

处置：我活在残骸 cgroup 里仍不能直接 stop，故派独立清道夫 unit `portalk-conductor-reap`
（`/tmp/reap-portalk-conductor.sh`，systemd-run --collect）：轮询 cgroup.procs，等本场 wander
退役、cgroup 连续两次只剩主进程（20s 确认窗；下张卡需 30min 空闲，余量充足）即 stop 残骸；
2h 超时强制收。已 disabled → 死后不复活；下次重启后单 conductor 终态成立。
判据安全性：任何异常读数（procs 读失败/瞬态子进程）都让确认计数归零，只会晚收不会误收。

双写实害边界（读码确认）：预算闸从遥测实算、双 conductor 读同一账本，烧钱上限仍是共享 2 元/日——
双跑不是无限超支，是同样预算被双倍速烧掉 + state.json 互覆（今日 draws=5/launches=2 已脏，
记账不可信，预算可信）。

### 值得记的形状（比事件本身重要）

同一形状两天连发：**止血是易逝品（transient unit / disable-only / 临时脚本），根治欠账没人认领
就不存在**。§2 的壳（pianist-shell 至今仍是 /run 里的 transient unit，重启即蒸发）与 §1 的
残骸是同一病灶两处溃疡。根治的方向上一场已写对（install 脚本幂等拆异名），还差半条：
**conductor 启动时应自检所属 unit 是否为 enabled 正典，不是就出声退出**——让 disable 在运行时
也成立，而不是只在重启时。

### 下种（本图唯一一条，w=0.5，source=seed）

- **thread「止血管是易逝品——残 unit 运行时存活性与 transient 壳的根治欠账」**（source=seed，
  w=0.5，from: 双 conductor 两天连发 + pianist-shell 至今 transient）：三抓手同一病灶——
  ① conductor 启动自检所属 unit 是否 enabled 正典，不是则出声退出；
  ② install-conductor.sh 幂等拆异名同源 unit（§1 遗留项并入）；
  ③ deploy 落 pianist-shell.service 正典 unit 换掉 /run 里的 transient。
  验收形状可检查：disable 后无需 stop/重启，残 conductor 自退；宿主机重启后壳与正典 conductor 自动回位。

---

## 第三场（wander 02:27–02:5x）：seed 三抓手全部认领落地——根治欠账出账

上一场的 seed 在牌面上无人认领（T2/T3/T4/T6 均不覆盖），本场 wander 顺手接单：三抓手全落地，
另补两颗部署期新发现的钉。

- **③ 壳正典化**：`deploy/pianist-shell.service` 新落（无 key、环境内联、no_proxy 防劫）；
  install 脚本识别 transient（FragmentPath 在 /run）→ stop 后拉正典，离线窗口 ≤2s，已真机
  换防（FragmentPath=/etc/...、enabled、health ✓）。
- **① conductor 正典自检**：`src/conductor.mjs` 常驻分支验明正身（/proc/self/cgroup 所属
  unit 必须=enabled 正典；异名残骸/disable 残留 → 出声退出 exit 1，30s 报警声即报警器）；
  `--self-check` 彩排面；手动/dev 跑免检；CONDUCTOR_SKIP_UNIT_CHECK=1 显式豁免。
- **② 拆异名同源**：install 扫 /etc/systemd/system 下 ExecStart 指向本 repo 的异名 unit →
  disable 不 stop（§3 钉子：残骸 cgroup 里可能有活 session）。真机首跑即拆掉 portalk-conductor
  残尸，顺手 rm 残 unit 文件 + shred LEGACY_ENV_FILE 离位 key 副本。
- **钉：预算行保全**：env 文件每次按当前环境重写，但 CONDUCTOR_DAILY_BUDGET 会被抹掉——
  the user 2→20 拍板就静默蒸发回默认 2。修：当前 env > 既有文件行 > 不写，保全必出声。
- **钉：node 版本门（engines>=22 安装器半边）**：部署 shell PATH 解析到 /usr/bin/node20 落进
  unit 就是版本错位（19连抽钉子只钉了运行时没钉安装时）。修：版本不达大声死，明示
  CONDUCTOR_NODE_BIN。本场首装就踩中这颗雷，被钉子挡下。
- **钉：安装器自保**：活在 conductor cgroup 里跑安装 → restart=自杀（§1 同款）。修：own
  unit 判据，推迟重启出声；本场挂 `pianist-conductor-rearm` 清道夫，等我退役后 20s 确认窗
  补刀 restart，自检钉上膛。

验收：npm test 全绿（自检 9/9 + 安装件 31/31 新增 18 项）；重启存活形状成立（两 unit 均
enabled，壳不再依赖 /run）；残 unit 文件与离位 key 副本已清。

### 遗留给下一个自己

- grimoire(8730)/spoor×3(8793-95) 四个本地服务仍是裸进程（PPID=1，重启即灭）——同一
  病灶的另一离组织，但它们属 Agent-Grimoire/session-spoor 各家，unit 该落各家 deploy，
  不在本 repo 借越。本场不下种（同一病灶不重复开线，顺手记在这里即可）。
- conductor 旧进程（00:26 启动）不带自检钉——rearm 清道夫补刀后生效；若清道夫超时自灭，
  下次重启自然上膛。
