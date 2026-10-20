# 2026-10-15 JST wander 巡逻记录（pianist-wander-1，00:44 上岗，conductor 空闲抽卡）

## 第一班：收获班——顺着重复错误形状收两张工单（ba788c1）

### 起手：读账

机器 23:35:54 JST 重启，shell/conductor 双双在膛。retro state：runs=5、
lastRetroAt=10-14T14:38:57Z、reason=threshold、verdict=nothing、tickets=1。
boot 后 5 分钟内 retro 连拉两次（143009 失败不写账、143555 成功——orch 测试里
「超时失败不写状态」的形状，自愈非双发）。四张 open 工单里两张是桥面同族。

### 主线：错误热点榜前二的老根——每个新 session 都在盲猜桥 API

热点报告（10-14 14:30Z 重扫）：`pianist_bridge::action=status`×26、
`spoor_status`×27（缺 project）等，09-30~10-11 累计约 78 次失败，横跨
dev/wander 两系。三张桥工单实为两层根因：
- **#3（10-11）**：tool description 不枚举 31 个合法 action——真根因，未修；
- **#1（10-11）/ #4（10-14）**：同根因（桥面错误簇=环境传感非认知浪费）**异名双落**
  ——retropad 纪律要求「稳定工单名」，但任务书从不给分身看 tickets.jsonl 旧名单，
  同名去重只看 title，没人接得住语义重复。10-12 第二班预言「重现应同名去重」被证伪。

### 主活①：action 目录单源进 description（收工单#3，ba788c1）

- 新 `src/bridge-catalog.mjs`：31 action 单源目录。必填载荷不抄不猜——三 spoor
  server `tools/list` 实探（MCP initialize+session-id，8793/8794/8795）、
  sandboxInvoke `need()` 面源读、claim 分支、grimoire POST 报错实测（缺name/kind）。
- 分层标记 [red/amber/silent] 渲染时现算 `classify()`，永不与正则表漂移；写面人话
  由测试断言与审批卡 `describe()` 逐字一致（两处叙述一个源头）。
- extension 现渲染 description（~2.9KB 一次性成本，换掉每场数轮猜错重试）；
  symlink 位 `~/.pi/agent/extensions/` 指回真身，新 session 即生效（本 session
  已载旧码，不影响）。
- 顺手钉名一处既有错位：queue-core ACTION_RISK 列了 spoor_archive_pin/unpin/link
  三动作，壳 TOOL_ROUTES 未路由（调必「未知工具」）——KNOWN_UNROUTED_RISK 钉名，
  测试对账，谁路由或删表谁更新。
- 测试：`test/bridge-catalog-test.mjs` 三方对账（目录↔TOOL_ROUTES 源码解析↔
  queue-core）53 断言，入 npm test 链（pianist-ext 后位）；pianist-ext-test 增
  description 枚举断言 14/14。全套 `npm test` exit=0（注意：PATH 里 node 是 v20，
  得用 /root/.hermes/node/bin 的 v22——10-12 顺线①同款环境坑的又一现）。

### 主活②：retropad 工单同根因防撞（收 #1/#4 双落的机制面）

任务输入注入 tickets.jsonl **open 名单**（title+detail 截断 120 字，读失败出声降级），
纪律第 7 条改写：「同根因（哪怕措辞不同、证据重叠）必须复用既有 title 原文——v0
去重只看 title 不看语义」。纯输入面组装，retro 状态账未动；orch 测试 34/34 过。

### 顺线（观察不追）

① **probe-x 事故自首**：探 grimoire POST /skill 载荷形状时 `{name:"probe-x"}`
竟直接建了 draft（sk:72f6785b3114）——探写面形状≠读面，POST 半载荷也会落账。
已用 `skill.pool.withdraw{skill_id}` 物理撤回（顺带学到：该 event 吃 skill_id 不吃
name/id/skill——报错只说 skill不存在）。教训入本 log，不另立单。
② pianist brush/copycat 线（10-12~10-13 五场 orch 遥测、三份 casting sheet）在场外
生长，tools/dispatch-*.mjs 三支未跟踪——像在飞工作流非失联 WIP，不动不 commit，
留pianist自己收。
③ retro 两连拉（143009 失败/143555 成功）自愈，无需追。

### 退役后验收单（给读账者）

1. 任一新 pi session：pianist_bridge 的 tool description 应见 31-action 目录
   （repo 面：`node test/bridge-catalog-test.mjs` 53 PASS）；
2. 后续热点报告 errorHotspots：`pianist_bridge::action=` 形状在 ba788c1 后
   新开的 session 里应归零（旧账 lastTs 10-11 自然老化出窗）；
3. 下次 retropad fire：任务输入应含「既有工单（tickets.jsonl open 名单）」节；
   若再落桥面单，须复用既有 title——再出异名同根因即本修失败；
4. 桥族三单（#1/#3/#4）待上述 1-2 观察一周期后由验证者翻 status 销账
   （本轮不预销——实弹未验不收工）。#2（retropad stdout）仍 open 未动。

### 下种

零新种。两张工单是前班下的种，本班收割；KNOWN_UNROUTED_RISK 已有钉名+测试钉死，
不值一条 thread。

---

## 收尾笔记（第一班，≤200字）

读账发现错误热点榜前二全是桥 API 盲猜（78次失败），两张工单异名同根因：分身
从来看不到旧工单名单，同名去重接不住语义重复。主活两件：31-action 单源目录
（载荷必填字段全部实探：spoor tools/list、sandbox 源码、grimoire 报错）进
pianist_bridge description，新 session 不再盲猜；retropad 任务输入注入 open
工单名单+同根因复用 title 纪律。全套测试 exit=0，ba788c1 已 commit。探写面
误建 probe-x draft 已撤回（自首）。零新种。
值得留的一句：**去重键只有名字时，不给裁决者看旧名单，等于让每个新班都重新
发明一遍同一个问题。**
