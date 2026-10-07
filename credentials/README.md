# credentials/ 钥匙柜——凭证=带强制遗忘的记忆

key 只出现在用户手里、存储文件里、发出去的请求里；永不出现在上下文/日志/遥测。
- 存储：`~/.portalk/credentials/`（每钥一普通文件，600；`PORTALK_CRED_DIR` 可覆盖）。用户全权：cat/编辑/删等效于接口。
- 来历（v2/T16）：存钥匙必须带 owner+purpose——`printf '%s' "$VAL" | node credentials/store.mjs write <名> --owner <谁> --purpose <为什么> [--scope a,b,c] [--scope-at ISO] [--verified declared|tested]`（值走 stdin，永不上命令行；缺 owner/purpose exit 2）。sidecar 落 `meta/<名>.meta.json`（明文不含值）：owner/purpose/scope+scope_snapshot_at（fine-grained PAT 授权名单是铸造快照，scope 必须带「截至何时」）/last_verified{source:declared|tested, at}。
- 补登/改档：`node credentials/store.mjs meta <名> [--owner …] [--purpose …] [...]`——merge 语义（传啥改啥），给 v1 老钥匙补 sidecar 用。
- 全柜视图：`node credentials/store.mjs status [--json]`——一条命令答hui三问（谁的/为什么存/管哪些仓截至何时/上次验证来源+时间）；无 sidecar 老钥匙显示「来历缺失」并 stderr 提醒补登，其余功能照旧。
- 墓碑：`destroy <名> [--reason <死因>]` 值照删，`meta/<名>.tombstone.json` 记 name/指纹/死因/时间（遗忘的是值，记住的是身份）；同名 write 复活时清墓碑。
- 代发：`node credentials/broker.mjs --name <名> --url <URL> [--header 'Authorization: Bearer {VALUE}'] [--body <str>] [--task <语境>]`——只打印响应。
- 注入：`node credentials/inject.mjs --env VAR=<名> [--task <语境>] -- <命令...>`——spawn 时装 env，透传 stdio 与退出码。
- 审批三档（tiers.json）：standing 常设预授权 / task 任务书点名即批 / per-use 逐次+复盘；清单外默认拒绝并出声。
- 兜底：mask.mjs 入口码掉（形状+语境，OTP 码掉即弃不落存储；非 OTP 自动落库自带 owner=auto-mask）；scan.mjs 全值精确匹配——journal 落账前必过。
记账：`data/cred-journal.jsonl`（只有名字没有值；use 事件可带 context 语境字段——envOrVault 第三参 / inject --task / broker --task，空串不落账）。
详见 docs/credential-vault-v2.md（T16）与 docs/t15-env-offline.md（T15）。
