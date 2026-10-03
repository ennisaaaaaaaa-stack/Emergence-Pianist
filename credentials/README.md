# credentials/ 钥匙柜——凭证=带强制遗忘的记忆

key 只出现在用户手里、存储文件里、发出去的请求里；永不出现在上下文/日志/遥测。
- 存储：`~/.portalk/credentials/`（每钥一普通文件，600；`PORTALK_CRED_DIR` 可覆盖）。用户全权：cat/编辑/删等效于接口。
- 写入：`printf '%s' "$VAL" | node credentials/store.mjs write <名>`（值走 stdin，永不上命令行）；`list` 只见名字。
- 代发：`node credentials/broker.mjs --name <名> --url <URL> [--header 'Authorization: Bearer {VALUE}'] [--body <str>]`——只打印响应。
- 注入：`node credentials/inject.mjs --env VAR=<名> -- <命令...>`——spawn 时装 env，透传 stdio 与退出码。
- 审批三档（tiers.json）：standing 常设预授权 / task 任务书点名即批 / per-use 逐次+复盘；清单外默认拒绝并出声。
- 兜底：mask.mjs 入口码掉（形状+语境，OTP 码掉即弃不落存储）；scan.mjs 全值精确匹配——journal 落账前必过。
记账：`data/cred-journal.jsonl`（只有名字没有值）。
