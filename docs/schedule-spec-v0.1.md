# EP-Schedule v0.1 spec 草稿——自主驱动的骨头层

状态：the author起草，the user 2026-10-12 对表完毕（六条拍板齐：§四三条+§五三条）。

## 一、定位

卡池是肉（闲时随机填充），schedule 是骨头（agent 对自己一天的确定性安排）。
两层共存：抽卡照旧在闲时跑，schedule 到点必触发——不走 cron，走 conductor
日程表（表现像 cron，实际 conductor 消费，编排名义归 pianist，守 9/28 归属纪律）。

## 二、卡池定案（五张牌）

1. tideline threads（记忆线索探索）——pianist施工中
2. 感官事件（env-event）——血源切换施工中
3. wander（无目的漫游）——已在
4. spoor todo（todo-review / spoor-session）——已在
5. 排 schedule 本身——新牌，抽中→排草稿

## 三、schedule 生命周期

抽中「排schedule」牌 → agent 读四源（threads/感官信箱/todo/wander 近迹）
  → 排草稿（时间表+每条理由）
  → 每日人类活动时间触发一次「推给人类」
  → 人类确认（权限档位决定确认形状）
  → 确认后落 conductor 日程表 → 到点 conductor 消费拉会话

## 四、已拍板三条（不重开）

1. 落地形状：conductor 日程表（schedule.json 或等价），非 cron。单一入口：
   预算、遥测、审批全走既有闸。
2. 预算优先级：schedule 先吃，余额才给抽卡。token 预算语义：烧完不再
   拉起新会话，当前 turn 保完整收尾（不硬切，同 100k session 切换哲学）。
   产品意见顺带落：100k 硬切阈值可配置不写死。
3. 权限三档（开源多用户现实）：
   - no-ask：schedule 无需询问，排好即生效
   - auto-safe：无危险操作自动通过（复用 ACTION_RISK 分流——amber 自动过、red 挂审批）
   - always-ask：必须审批才生效
   默认档：always-ask（信任要挣得，不预支——开源用户第一面）。

## 五、已拍板分叉（the user 2026-10-12）

1. 「人类活动时间」：不硬编码。初始预设北京时间 10:00-22:00，agent 可基于
   user 实际活动时间自适应调整。
2. schedule 粒度：直接做复合带参数（「14:00-16:00 深耕线程 #33」）。
   理由：part 级早晚要长出参数，先简后繁会留半成品；前端 schedule
   可视化需要结构化数据（时间窗+对象+意图），现在就按这个形状埋。
3. 日程表过期语义：跳过。与 cron 一致不补跑——机器没开就是没开，
   抽卡/拉取逻辑也不看终点，同族语义。

## 六、开放问题（记下不急答）

- schedule 修改权：生效后 agent 自己能改吗，还是要重走确认？（我倾向：
  no-ask 档可自改、auto-safe/always-ask 档改动重走确认）
- 冲突消解：schedule 到点时正在跑长任务怎么办？（conductor 现有 idle 判定
  是否够用）
- schedule 与 retro-trigger 的关系：复盘产出的 hotspot 该不该自动进 schedule？
  （「值得做的活自己排班」——这个我直觉上很想做，但先记着）
