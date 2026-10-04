# T15 活二 · 沙箱×钥匙柜接缝——沙箱内 agent 隔墙喊 broker

> 状态：已施工（沙箱内 agent 使用契约）
> 出处：portalk 牌面 T15（凭证卫生）；本活=接缝：T10 轻档沙箱 × T11 钥匙柜。
> 判据：接缝完工即验收（测试 test/sandbox-broker-test.mjs 两遍绿 + 全套 npm test 绿）。

## 一、这扇门解决什么

沙箱内的 agent 跑测试常常要调 LLM API 等外部服务，但沙箱内零凭证（Landlock 挡柜、降权
nobody），且值绝不能进沙箱文本域。设计定案（照字面执行）：

- **通道复用 gate-proxy**：沙箱出网唯一门是 gate-proxy（unix socket 跨 netns，跑在沙箱外
  root 侧）。接缝不开新洞——只在 gate 上加内部端点。
- **保留域名 `vault.internal`**：沙箱内 env 已设 `http_proxy=127.0.0.1:8788`；目标为
  `http://vault.internal/use` 的明文代理请求被 gate 识别 hostname 后**不出网、不过白名单
  decide**，直接转墙外 broker 逻辑。`.internal` 是保留域，不会撞真实域名。CONNECT 不涉及。
- **纯度第一档语义不变**：沙箱内 agent 给模板（header/body 里 `{VALUE}` 占位符），
  `brokerCore`（credentials/broker.mjs）墙外读柜、填值、直连真实目标、**只回响应 body**——
  与 `credentials/broker.mjs` CLI 完全同构，key 永不进沙箱进程文本。

## 二、沙箱内 agent 使用契约

### 请求

```
POST http://vault.internal/use        # 走环境自带的 http_proxy，无需特殊配置
Content-Type: application/json
Content-Length: <长度>                 # 必须带；不接受 Transfer-Encoding: chunked

{ "name":   "coding-plan",            # 钥匙名（只有名字，柜在墙外）
, "url":    "https://api.example.com/v1/chat"
, "method": "POST"                     # 可选，默认 POST
, "header": "Authorization: Bearer {VALUE}"   # 可选，字符串或字符串数组，模板
, "body":   "{\"model\":\"x\"}"               # 可选，模板（{VALUE} 占位）
}
```

沙箱内最简姿势（curl 天然吃 http_proxy）：

```
curl -sS -X POST http://vault.internal/use \
  -H 'content-type: application/json' \
  --data-binary '{"name":"coding-plan","url":"https://api.example.com/v1/x","header":"Authorization: Bearer {VALUE}"}'
```

（node 的 http 模块不自动吃 http_proxy；沙箱内请用 curl，或自己连 127.0.0.1:8788 发绝对地址。）

### 响应

- **200**：body = 真实目标的响应 body 原文（已过 scanText 保险带，见§三），`application/octet-stream`。
- **403**：授权拒（钥匙无审批配置 / per-use 未批）、柜无此钥匙、内网目标默认拒。
- **400**：形状坏（缺 name/url、header/body 类型不对、坏 JSON、chunked、多个 Content-Length）。
- **404/405**：非 /use 路径 / 非 POST 方法。
- **413**：请求体超上限 1 MiB。
- **502**：上游失败（DNS 解析失败、curl 非零退出）。
- 错误 body 一律 `text/plain` 人话（`vault.internal: <原因>`），同样过 scanText。

### 记账

每次成功使用落 **cred-journal**（credentials/journal.mjs 的 journal()）一条：

```json
{ "v":1, "ts":"...", "agent":"<policy.identity.agent>", "action":"use-sandbox-broker"
, "name":"coding-plan", "tier":"standing", "method":"POST", "host":"api.example.com" }
```

`agent` 是**沙箱工牌**（策略 `identity.agent`），不是 pianist 默认值。只有名字没有值
（与 use-broker / use-inject 同本子）。vault.internal 拦截本身不落 sandbox-journal——
钥匙柜的事记钥匙柜的账。

## 三、值永不出柜的保证链（谁在哪一环兜住）

1. **沙箱内只有模板**：`{VALUE}` 占位符经 netns → relay → gate，值从头到尾不在沙箱文本域。
2. **墙外读柜**：brokerCore 在 gate 进程（root 侧）读 `readValue(name)`，经 tiers 授权闸。
3. **值不上命令行**：header 走 curl `-H @file`、body 走 `--data-binary @file`（600 权限
   临时文件，用完即删）——`ps` 看不见，argv 不留痕。
4. **回包洗一遍**：响应 body 与一切错误文本过 `scanText`（全量存储值精确匹配，命中替换成
   `[credential:<名>]`）才写回沙箱 socket。
5. **记账只落名字**：journal() 写前再过一遍 scanText（指纹兜底最后一道闸）。

测试纪律同 credentials.test.mjs：断言只出布尔/长度，夹具值永不上输出。

## 四、反探洞（本接缝的命门）

broker 在墙外有全网访问权；沙箱内 agent 若能把目标指到内网，等于借 broker 绕过沙箱
netns 隔离探测内网。堵法：

- brokerCore **默认拒** RFC1918/环回/链路本地/CGNAT/ULA/0.0.0.0/组播目标（IP 字面量直接拒；
  域名做 DNS 解析复核，解析到上述网段也拒）。CIDR 判定复用 gate-proxy 的
  parseCidr/ipInCidrs（单一实现，两处共用）。
- 逃生门是 **options 参数 `allowPrivate`**（默认 false），仅测试显式传；**核层无 env 后门**
  （test/sandbox-broker-test.mjs §2 有专测：设了 env 也不放行）。
- gate 侧的集成测试开关：`PORTALK_SANDBOX_BROKER_ALLOW_PRIVATE=1`（仅测试置位；不设=拒内网，
  默认安全）。这是给「mock 起在环回上」的集成夹具用的，生产回合不设。
- 回归线：沙箱内直接 curl 真内网地址仍被原门禁 403 硬拒（接缝没松原有的门）。

## 五、与 T9 章位（sig）的结构位关系

T9 §五定案的身份结构=工牌+钥匙+**章位**（先留位后刻章）：策略 `identity.{agent,keypair,sig}`
已留位，第一版不填不验。本接缝是将来**刻章的挂点**：

- 现在：vault.internal/use 的请求只带钥匙名（工牌=记账字段 `agent`，不参与验证）——自家
  屋内钥匙全在系统手里，无人可冒充，够用。
- 将来（启用判据与重档同步：第一个第三方 agent 入住或第一次跨家门协作那天）：
  沙箱侧请求信封可携带 `identity.keypair` 对请求体 的签名（信封 sig 字段），gate 在
  handleVaultUse 里验签后再进 brokerCore——谁喊的钥匙可验证，署名从自觉变事实。验签
  从 0 到 1 不改协议形状（加字段即可），本活不实现，只在此记位。

## 六、实现落点（改动面）

| 文件 | 变更 |
|---|---|
| credentials/broker.mjs | 拆核 `brokerCore({name,url,method,headers,body,allowPrivate,journalAction,agent,intentPrefix})` 导出；CLI 壳行为零变化（新增 `--allow-private` 测试夹具旗）；反探洞默认拒 |
| sandbox/gate-proxy.mjs | 导出 parseCidr/ipInCidrs；vault.internal 内部端点（按 Content-Length 攒足 body 再处理）；decide 在途字节不再丢（原有竞态顺手修） |
| credentials/journal.mjs | fields.agent 可显式指定记账工牌（沙箱路径传 policy.identity.agent） |
| test/sandbox-broker-test.mjs | 新：单元级（brokerCore 直调）+ 集成级（真沙箱回合），26 项 |
| test/credentials.test.mjs | §6 mock 夹具补 `--allow-private`（拆核后默认拒内网所致，语义=测试逃生门） |
| package.json | npm test 挂 test/sandbox-broker-test.mjs 一行 |
