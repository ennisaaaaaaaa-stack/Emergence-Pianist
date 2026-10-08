# T16 钥匙柜 v2：sidecar 元数据 + 来历记账 + 墓碑（2026-10-07）

## 背景

洄洄找凭证找到痛苦，暴露 v1（T11）是「匿名保险箱」：`store list` 只出裸名字，答不了
「这把钥匙是谁的、为什么在这、管哪些仓、上次验证什么时候、还能不能用」。当天还踩了结构性 403：
fine-grained PAT 的授权名单是**铸造时刻的快照**——钥匙没坏，但开不了后来建的门。
所以 scope 元数据必须带「截至何时」，验证状态必须带来源标注（声明 vs 实测不许混称）。

## 三件套契约

### ① sidecar 来历档案（meta/ 子目录）

每把钥匙一份 `~/.portalk/credentials/meta/<名>.meta.json`（明文，不含值，600）：

- `owner` / `purpose`：谁的、为什么存——**write 强制来历**：CLI `--owner --purpose` 缺一拒绝 exit 2；
  API `write(name, value, meta)` 缺 owner/purpose 抛错。唯一豁免形状：自动落库方自带 owner
  （mask.mjs 码掉落库 `owner:"auto-mask"`）。
- `scope` + `scope_snapshot_at`：管哪些仓（数组，CLI `--scope "a,b,c"` 逗号分隔）+ 快照时刻
  （缺省=写 sidecar 时刻；`--scope-at <ISO>` 显式给是考古补录）。后来建的门开不了，看时间戳就知道。
- `last_verified`：`{source:"declared"|"tested", at}`——声明（口头/文档）与实测（真请求）二值，
  不许混称；**没有默认 verified**，不登记就显示「从未验证」。
- 放 meta/ 子目录（700）而非柜目录同层：`<名>.meta.json` 能过 NAME_RE，同层会污染 `list()`。

### ② 墓碑（destroy 留档案）

`destroy <名> [--reason <死因>]` → 值文件照删 + `meta/<名>.tombstone.json`
（name / fingerprint sha256 前 8 hex / reason 缺省「未注明」 / ts）。遗忘的是值，记住的是身份。
sidecar 随钥匙下葬（墓碑是死钥匙唯一档案）；**同名复活**：write 同名成功时清掉墓碑。
journal destroy 事件照旧。

### ③ use 记账带语境（context）

journal 的 use-vault / use-inject / use-broker（含沙箱 use-sandbox-broker 走的同一 journal()）
支持可选 `context` 字段（自由字符串，约定 `<调用方>:<语境>`）。journal() 层卫兵：不传/空串不落账，
不许 `"context":undefined` 污染账本。三个口全透传。

## 命令面（store.mjs v2）

| 命令 | 用途 |
|---|---|
| `write <名> --owner <谁> --purpose <为什么> [--scope a,b,c] [--scope-at ISO] [--verified declared\|tested] [--verified-at ISO]` | 存钥匙（值走 stdin），来历强制 |
| `meta <名> [--owner …] [--purpose …] [...]` | 补登/改档，**merge 语义**（传啥改啥，不传保留）——v1 老钥匙补 sidecar 用 |
| `status [--json]` | 全柜视图：活钥匙 owner/purpose/scope+截至/验证来源+时间；墓碑区单独一段。人读表格 + `--json` 机器读 |
| `destroy <名> [--reason <死因>]` | 销毁 + 墓碑 |
| `list` / `has` / `fingerprint` | 同 v1，零变化 |

## 接线表（context 透传）

| 消费点 | 接线 |
|---|---|
| conductor launchPart | `envOrVault("ZAI_CODING_CN_API_KEY", "coding-plan", "conductor:launch(<part.id>)")` |
| retropad | `envOrVault(…, "retropad:launch(复盘分身)")` |
| inject.mjs | `--task <语境>` → use-inject 事件 context |
| broker.mjs | `--task <语境>` → use-broker 事件 context（brokerCore 参数 `task`，gate-proxy 未传则无字段） |
| mask.mjs | 自动落库自带 `owner:"auto-mask"`（write 强制闸的唯一豁免形状） |

## 老钥匙兼容（不炸承诺）

无 sidecar 的 v1 钥匙：has/readValue/use/list/inject **全部照旧**；status 显示「来历缺失」+ stderr
出声提醒补登。用户仍是凭证的主人：cat/编辑/删文件等效接口不变。

## 与 T11 / T15 的关系

- T11 建的柜（存储/审批三档/broker/inject/journal/scan 闸）原样不动——v2 只加档案面（sidecar/墓碑/status）
  和记账面（context 字段），tiers.mjs 审批逻辑与 mask.mjs 判定逻辑本体零改动。
- T15 的 envOrVault 供给口不变，只加第三参 context（透传不造）。
- 写时刻记来历（owner/purpose），用时刻记语境（context）：考古问「为什么在这」找 sidecar，
  审计问「谁在用」翻 journal——两个时刻缺一不可（v1 只有后者的一半）。

## 设计洞见存档（超出本案可复用）

- fine-grained PAT scope 是铸造快照 → 元数据光写「管 A/B/C」不够，必须带「截至何时」。
- 验证状态带来源标注：用户在 GitHub 侧改过授权而元数据没更新时，status 不许自称 verified——
  declared/tested 二值兜住。结构性 403 场景下 agent 应在发请求**前**预判。
