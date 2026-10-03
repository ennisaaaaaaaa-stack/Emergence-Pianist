# 2026-10-04 JST wander 巡逻记录（pianist-wander-1，03:13 上岗）

## 起手：三天空窗后的第一口活气

host 从 10-02 04:46 JST 起黑到 10-04 01:34（conductor 自报空闲 2688min）——没有
10-02/10-03 的 wander，没有遥测，journal 只剩 T7/T8/T9 的 dev 施工痕迹（10-02 四场
todo-review，10-04 02:44 T9 定案 commit）。黑屋里第一拍：心跳开跳（报告陈旧>20h →
扫描器上膛，42 文件 2329 事件），随即抽中 wander——01:41 被 systemd stop 打断 +
宿主再 reboot，**死因 `parent-down` 入账**：T7「launch 先写后做+两死法死因入账」的
首次活体战损记录，零遥测零报告但死也留名。02:01 复活后 spoor（指纹冷却次日照拦）、
todo-review、然后是我。

## 病灶一（认领③线软错盲区）：壳的失败信封在错误道里是隐形的

10-01 留话「谁捡③谁顺带定夺」。坐实全链：壳对**未知动作**与**提供者 HTTP 级错**都回
`HTTP 200 + {error:…}`（shell.mjs 失败信封约定；`可用：…` 动作清单就在里面），而
extension 把它当正常返回交回 pi——pi 的契约是**返回值永远 isError:false，唯一错误道
是 throw**。env-event 六场猜动作名（611 字节「成功」装着动作清单）就是这么隐形的；
dev-1 的 spoor_status ×20 能进 errorHotspots 纯属侥幸（ECONNREFUSED 走 throw→502）。

修在 extension：见顶层 `error` 字符串即 throw，message 带壳的原文——模型照样看得见
「可用：…」清单（转向力不减），errorHotspots 从此数得到猜名失败（`pianist_bridge::
action=X` 形状现成）。非失败信封不误伤：红牌等审批 `{deferred:true,approval}`、读面
`{status,body}`（状态码是数据不是失败）照常返回。test 5c/5d 两检查（throw 带原文 /
deferred 不 throw），pianist-ext-test 9→11，全套 npm test 299 PASS / 0 FAIL exit 0。

## 病灶二（巡查自逮，比病灶一大）：extensions/ 从未有过部署路径

给病灶一做部署面体检时发现：pi 只从 `~/.pi/agent/extensions/*.ts` 自动发现，repo 的
`extensions/` 不是加载路径——而那个槽位里躺着 **9-22 initial release 的旧副本**
（与 410bb2f 逐字节同）。12 天里三个「已部署」的修复全都只活在 repo 和测试里：
洞1 遥测丢弃出声（09-25）、`/tools/invoke` agent 署名（09-29，T3 notify_claim 依赖）、
本场软错修。09-29 那场写的「代码倒是部署成功了」只对 conductor.mjs 成立（systemd
restart 换血）——extension 面没有任何部署机制，谁的哨都没响，因为旧副本「能用」。

修：副本换**符号链接** → `REPO_HOME/extensions/pianist-tools.ts`。依据
（都验过源码）：pi 发现语义明写 `entry.isFile() || entry.isSymbolicLink()`；bundled
jiti 的 `@sinclair/typebox`/`pi-coding-agent` import 走 VIRTUAL_MODULES，与文件位置
无关（本地裸 jiti 复现加载失败恰好反证真加载路径不吃文件系统解析）。从此 working
tree 即部署，drift 结构性不存在——本场未提交面只有自己两个文件（查过 git status，
作者的 T9 已全提交），下一场 draw 起三个修复同时首次上膛。README Conductor 节补
部署纪律一段。

## 巡检（观察不追）

- env-event：fail_streak=4、backoff_day=10-02 已过期，今晨 4 draw 没抽到它（wander×2/
  spoor 冷却拦一次/todo-review）——纯手气，不是病。下次抽中即新 prompt 首战。
- 心跳：01:34 重启首拍扫过（陈旧>20h），02:01 复活不重扫（窗内）——双扫免疫按设计活着。
- sandbox-journal 里 example.com/example.net 的「先通后报」放行是作者 T9 测试流量
  （本场 npm test 的 sandbox 面也在添），不追。
- 10-01 dev-1 spoor_status ×20：transport 级红可见，但 spoor workbench (8793) 的
  HTTP 级错从今天起才可见——下次这类形状冒头，errorHotspots 不会漏。

## 下种：零新种

③线（同型异辞收敛盲区）仍开：本场闭了它的「软错」子项（错误可见性），收敛门本体
（措辞各异的同型失败如何归一）还没人动。不另开 thread。

---

## 收尾笔记（≤200字）

三天空窗后第一拍。认领③线软错盲区：壳失败信封 200+{error} 经 extension 返回值交差，
pi 的错误道唯一入口是 throw——猜动作名 12 天隐形。extension 改为见 error 即 throw
（原文随行，模型仍看得见动作清单），11 检查全绿。部署体检自逮更大的病：live 加载位
是 9-22 旧副本，三个「已部署」修复从未上膛——副本换符号链接，working tree 即部署。
值得留的一句：**测试绿不是部署，green in repo ≠ live in house——每个「已部署」都要
能指出加载它的那个进程。**
