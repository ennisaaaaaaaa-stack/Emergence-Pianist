# 2026-09-30 JST wander 巡逻记录（pianist-wander-1，02:42 上岗）

## 起手：09-30 无报告上岗——先看昨夜的自己们烧了什么

state.json 09-30(JST)：本场是当日第 5 draw。昨夜凌晨四场——spoor-session×3
（00:09/00:57/02:09，共 $0.42）+ env-event×1（01:36）。env-event 01:36 预取又撞
`no such table`：病名行按新代码正确出声、fail_streak=1（退避阈值 3 未到，行为全符合
7f4879d 设计）；表名缝 CONDUCTOR_EVENT_TABLE 仍欠人侧部署——观察不动，等得起。

## 病灶一（认领 a793481）：spoor-session 三连空牌——牌面指纹冷却

三场 spoor-session 在**同一张逐字没变的牌面**上（journal 里「够格1/跳过7（缺出处7·
缺判据2·缺预算0）·格式非法5/8 项目」逐字重复三遍）各自从零重演同一套冷启动探索
（ls→find STATUS.md→read 同两份 STATUS.md→journal 考古），得出同一句裁决
「够格值得动0：tideline-v26 T3 卡上游——collaborator-B包未到」。场间只越跑越快（17min→8min→
3min），探索前缀照旧逐字重演。与 env-event 饿死退避同族（空牌确认跑不因重跑而愈）
不同病（拉得到 vs 拉不到）：门形改为 **launch 行落牌面指纹 faceHash**（boards 结构
全量 sha256 前 16 位，只指纹牌面不指纹裁决——裁决是分身的活），上一场 exit=0 的同
指纹记录距今 < 冷却窗（CONDUCTOR_SPOOR_FACE_COOLDOWN_H，默认 12h）→ 本轮不抽；
牌面一字之变 / 窗过 / 上场死产 / 旧格式记录 → 资格立即恢复（裁决含时间维：到期日会
走、上游包会到而牌面未必同步动，故必须有窗不能只认指纹）。全池冷却时出声不抽、
draws 不虚记。test/spoor-face-cooldown-test.mjs 12 检查（含一课：改最后一条 exit=1
不够——反向找的是最近一场同牌面且正常收工的记录，旧有效裁决不作废，这是对的）。

## 病灶二（认领 afbc961）：部署缝回归——env 重写通用缝保全

部署病灶一之前体检发现：install-conductor.sh 重写 /etc/pianist/conductor.env 只保全
预算/表名两行，**fba4b11 落的 CONDUCTOR_SVPS_SSH 会被我自己的安装静默蒸发**——装
新钉的动作顺手拆掉上一场装的缝。「缝不因重装蒸发」纪律一般化：文件里任何
CONDUCTOR_* 键，当前 env 带 → 写当前值，未带 → 原行保全出声；只保全既有键不引入
新键（session 环境不顺手漏进正册）。conductor-install-test 5c +2 检查（36/36，测试
环境剥净 CONDUCTOR_* 噪声保密封）。

全套 npm test 18 件 exit 0。T5b the author复验队列新增本场两笔（a793481、afbc961）。

## 巡检（观察不追）

- **todo-review 09-29 23:09 场烧 $1.00**：48 bash 做出处考古（翻旧 session
  transcript/journal/ledger 验「有人接过这一单」）——这维机判做不了（judgeSpoorBoard
  只查出处栏非空），活该烧钱；但考古结论只活在 transcript 里，下个空闲窗谁也不能复用。
- **发现闭环没有心跳**：data/hotspots/latest.json 停在 09-25（五天没人扫）。扫描器纯
  机械免费、按设计「每次全量重扫」，但只在有人记得时跑。本场顺手 `--out -` 扫了一遍
  （不落盘）：热点仍是 dev-2 的 fixture 旧账；今晚三连重演它**看不见**——文本收敛门
  对「同型异辞」的探索前缀是瞎的（三场命令措辞各异、形状相同，convergence<0.8 全拒）。
- **部署**：本场从 conductor cgroup 里跑正典 installer（自保分支出声推迟 restart），
  systemd-run 挂正典 rearm（deploy/rearm-conductor.sh，cgroup.procs 探针）等我退役后
  补刀——正典清道夫件首次真用，09-29 的手搓版没有存在理由。
- 09-26 seed 三钉存活依旧；别家 deploy 维持不越界。

## 下种（本图唯一一条，w=0.5，source=seed）

- **thread「发现闭环没有心跳——scanner/retropad 只在有人记得时跑」**（source=seed，
  w=0.5，from: latest.json 停 09-25 五天 + 09-30 三场 spoor 重演无人抓）：给
  「替重复劳动编译掉重复」的闭环自己接上心跳。抓手 ① 最小：systemd timer 每日跑
  hotspot-scanner 落 latest.json（纯机械零 LLM，不进 part 池不烧抽卡预算）；②
  retropad 按需：latest.json 真出新热点才拉分身（「没有值得记的」是多数，别为空
  报告烧钱）；③ 长线病例先记不急动：收敛门对「同型异辞」探索前缀的盲区（指纹归一
  化，09-30 三场 spoor 是现成 fixture）。验收形状可检查：latest.json 生成时间永不见
  25h+；一处新重复形状从发生到进报告 ≤1 天。

---

## 收尾笔记（≤200字）

09-30 凌晨验尸：spoor-session 在同一张没变的牌面上三连空牌（$0.42 重演同一套探索、
同一句「值得动0」）——env-event 饿死退避的病换了个宿主。认领 a793481：launch 行落
牌面指纹，同指纹 12h 冷却窗内不重抽，牌面变/窗过/死产即恢复。部署前体检又逮住
afbc961：installer 重写 env 会静默蒸发 SVPS_SSH 缝——「缝不因重装蒸发」一般化到
所有 CONDUCTOR_* 行。18 件全绿。下种一条：发现闭环自己没有心跳（latest.json 五天
没扫）。值得留的一句：**空牌确认跑不因重跑而愈——但裁决含时间维，冷却门必须带窗，
只认指纹会把「等到包到」冻成「永远不看」。**
