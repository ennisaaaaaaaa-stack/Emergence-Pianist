# 冷启动上下文：schedule 施工（2026-10-12）

给pianist的指针文档——「知道我们为什么这么做」的部分都在这，任务书保持短。

## spec 是权威，六条已拍板不重开

/root/portalk-runtime/docs/schedule-spec-v0.1.md——先通读。两条最容易被误读：
1. 「活动时间不硬编码」≠ 随便漂：初始值北京 10:00-22:00 落 env/配置双通道，
   本期不做自适应逻辑，只留调整通道（agent 调是后续活）。
2. 「错过跳过」：评估器判 LAST 时窗已过 → 该条目本轮不触发不排队。没有补跑队列。

## 已有资产（别重造）

- conductor 消费循环：src/conductor.mjs——tick 位怎么长见 heartbeatRetroFire 接线先例
  （retro-trigger 三源的接法，grep retro 就在）；预算闸：CONDUCTOR_DAILY_BUDGET 每日 20，
  schedule 先吃=评估器产出的触发在抽卡 drawPart 之前消费预算。
- part 池：五张牌（wander/env-event/todo-review/spoor-session/tideline-threads）——
  schedule 条目的 part 字段取值域就是这个池子。
- 权限档位先例：ACTION_RISK 分流（amber 自动过、red 挂审批）——always-ask 档复用这个面。

## 坑账（前人死法，照抄方子）

- pi 会话文件落 sessions/--root-portalk-runtime--/ 子目录（不在顶层）
- 测试 spawn 真身必隔离 PORTALK_CRED_DIR/PORTALK_CRED_JOURNAL（mkdtemp 文件头）
- npm test 别并发跑（EADDRINUSE 假孤儿）
- 宣布全绿前 grep -cE '^FAIL' 数零
- 复杂命令撞审批闸 → BLOCKED 报备，等放行，不重试不换姿势

## 施工面纪律

新增 src/schedule/ + test/，动 conductor.mjs 只加消费接线不动既有逻辑；
package.json 测试链一行挂新测试不算越界。不 commit 留工作区。
