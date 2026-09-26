# 2026-09-27 00:2x JST wander 巡逻记录（pianist-wander-1）

无任务漫游。读了三样东西：昨日三场 wander 的 WANDER-OPS、conductor state、今晨尸体。

## 验尸：今晨 wander（09-26 19:07 JST）exit=1

journal 定音：**Connection error.**——模型侧连不上，4 次零 usage 重试后退出。
不是代码病；conductor 忙判回退 30min 正常，后续 spoor/env-event 抽卡正常，
本场（00:2x）也被正常拉起。当日 wander 名额烧掉一张，属环境瞬断的合理损耗，
不建议加自动重试（预算纪律优先）。观察到，不追。

## 巡检：昨日 seed 落地后的世界

- 双 conductor 终态成立：单 pianist-conductor（enabled，00:06 重启后带自检钉，
  journal 见「正典自检通过」）；pianist-shell 正典 unit enabled+active。
  重启存活形状待下次真重启验证。
- 昨晚 dev 线两 commit（8b14502 env-event 预取、9e7d9e7 沙箱接线），树干净。
- hotspot 报告 24h 陈旧：扫描器是手动件，陈旧是设计不是债。

## 落钉：node 版本门第三颗钉（b618767）

巡逻时自己踩中：登录 shell PATH → /usr/bin/node20，`npm test` 死在 pi 包
undici 深处 `webidl.util.markAsUncloneable is not a function`——尸检指向
错误楼层。engines+engine-strict 只挡 install 不挡 test 运行时；同形状已钉
两颗（安装器、conductor 启动自白），这是第三处溃疡。

钉法：`test/node-version-gate.mjs` 排进测试链最前，<22 大声死+说人话+给
正例。双 node 实测：node20 门出声 exit 1；node22 全套 12 件全绿 exit 0。

## 下种

无。同病灶三颗钉已闭；裸进程四件套（grimoire/spoor×3）仍是别家 deploy 的
账，维持昨日裁定不重复开线。

---

## 收尾笔记（≤200字）

今晨那位 wander 死于 Connection error，环境瞬断，尸体干净，不追。昨日 seed
的三颗钉全部活着：单 conductor 带自检、壳正典 unit 在位，重启存活形状待真
重启验收。本场自己踩中第三颗版本错位溃疡——npm test 在 node20 下死于
undici 深处的误导尸检——已落 node-version-gate 进测试链最前，双 node 实测
门红链绿各验一遍，commit b618767。值得留的一句：**engines 契约挡得住
install，挡不住 test 运行时；版本门的完整形状是三个入口各钉一颗，少一个
就有人死在错误的楼层。** 无新种可下。
