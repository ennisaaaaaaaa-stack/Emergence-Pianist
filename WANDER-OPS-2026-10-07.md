# 2026-10-07 JST wander 巡逻记录（pianist-wander-1，03:31 上岗）

## 第一班（03:31 上岗）：第四班的预言被证伪了——顺着证伪挖出软错病灶第二层，当场补刀

### 起手：验昨班预言

第四班收尾留了两条尾巴：一、「下份报告里 spoor_status 形状应现 502→2xx 迁移」（16:52 探针
后的预言）；二、deploy/ 未收录 spoor unit 的脚注。上岗先验第一条。热点报告 18:57 生成
（比探针晚约 2 小时），wander-1 的 spoor_status 错形 **lastTs 停在 10-05 19:00Z，count 3
未动**——探针根本没落账。预言不是「被误读」，是**没被看见**。

### 验尸：六环证据链

1. 原始遥测：第四班空参探针（07:52:40Z）记的是 `isError: false`，resultBytes 336——
   pydantic 错信封的尺寸。第四班「诚实账」预期它落错形，**记错了机制**。
2. 本班实弹复现：`spoor_status` 空参 → 桥返回 `{content:[pydantic 文], isError:true}`
   作为**正常工具结果**——信封里的 isError 是数据，不是工具错。
3. 壳侧（shell.mjs parseMcpResponse）：MCP result 原样透传 `{content, isError}`。
4. 扩展侧（pianist-tools.ts）：10-04 的「软错不软抛」只 catch 顶层 `{error}`；
   MCP `result.isError:true` 从指缝漏过，作为 JSON.stringify 数据返回。
5. 扫描器（hotspot-scanner.mjs L148/153）：只认 `data.isError === true`。
6. 闭合：供应商级语义错（缺参/坏工具名）对热点层**全黑**。历史 21 次 spoor_status
   错形之所以可见，只因未接线时代抛的是硬错；昨天三实例上线后，同一类错换了软形，
   错误道就哑了——部署成功反而关掉了观测灯。

### 施工：同病灶深一层，wander 补刀（先例 17de7cb）

10-04 wander 补了顶层 `{error}` 层；本班补 MCP `isError:true` 层，同文件同测试同风格：

- `extensions/pianist-tools.ts`：failText 双分支，两层失败信封都走 throw（message 带
  原文报给模型）；非失败信封照常返回——`{deferred}` 报批、读面 `{status,body}`、
  MCP 成功 `{content,isError:false}` 是数据不是失败。
- `test/pianist-ext-test.mjs`：+5e（MCP 错信封 throw 带提供者原文）+5f（MCP 成功面
  照常返回，防顺手加固），均入 checks 硬门禁。
- 自验：突变双侧——删 isError 分支 → 5e 红；`isError!==false` 过括 → 5d 即炸
  （deferred 信封也被拖下水，负控比预想更强）。node22 全套 `npm test` 两遍绿
  （`PATH=/usr/local/portalk-node/bin` 前置；ambient v20 被 node-version-gate 拦，
  属环境现状非本刀）。提交 **fbd3c71**，复验留 the author。

### 巡检（观察不追）

- 昨日两把新铲子（130cb0d orch-v0、ab908f4 skill-gate v2）均带作者复验记录
  （通读+两遍绿+四点突变），刚收口的缝，不压跟踪债。
- spoor 三口仍活（实弹探针即证）；第四班 deploy/ 脚注作者未动，随他。
- 图上零在途线（threads:[]），今日 $0.76/4 抽（我上场前），预算无压力。
- 诚实账：本班 03:33 那发实弹探针在**旧扩展**下发出，会以 isError:false 落本班
  遥测——它是证据不是回归；下任读热点报告时别把它数进「补刀无效」。

### 下种：零新种

补刀已在单 session 内闭环（判据「MCP isError 信封走错误道」由 5e 钉死），无在途
决策，不欠跟踪债。观察点（非种）：修复仅对新加载的 session 生效，首个在新扩展下
踩缺参的分身会把 `pianist_bridge::action=…` 错形刷进热点报告——那将是本刀的野外验收。

---

## 收尾笔记（第一班，≤200字）

验第四班预言：热点报告里 spoor_status 错形没刷新——探针 07:52 落的是 isError:false。
六环验尸：MCP result.isError:true 被扩展当数据返回，供应商语义错对热点层全黑；部署
成功反而关了观测灯。同 10-04 病灶深一层，补刀一行分支＋5e/5f 双钉，双突变红、
node22 两遍绿，fbd3c71 落账。零新种。值得留的一句：**预言没兑现时别急着找「为什么
没发生」，先问「它在哪一层没被记下来」——多数失踪不是没发生，是观测灯没照到。**
