# T15 活一：env 过渡态下线（2026-10-05）

## 背景

T11 钥匙柜落地后，coding-plan key 已迁入 `~/.portalk/credentials/`，但消费侧仍在走老路：
派活驱动器从 `.bashrc` 提取明文、conductor 从 `/etc/pianist/conductor.env` 明文行取 key。
本活把这两条「明文 env 过渡态」收口——值只住钥匙柜，消费进程启动时从柜读一次装进 env。

## 供给契约（credentials/env-source.mjs）

三态，值不出模块边界（返回给调用方装 env，任何调用方不得打印）：

1. **柜有** → 读柜 + 落 `use-vault` 事件（记账只有名字没有值，与 broker/inject 同纪律）
2. **柜无、进程 env 有** → 过渡回落：stderr 出声 + `env-fallback` 事件——回落日志就是「明文 env 还没死透」的存量清单，全部消费点切柜后应绝迹
3. **双无** → 返回 undefined，由调用方各自的「缺 key 大声死」兜底（既有测试钉着，不重复造）

## 六个消费点接线

| 消费点 | 接线方式 |
|---|---|
| conductor launchPart | `envOrVault()` 装进 spawn env |
| retropad | 同上 |
| install-conductor.sh | 探柜三态：柜有 → env 文件不写 key 行（明文残留面收口）；柜无+env 有 → 过渡态照写+出声；双无 → 大声死 |
| qinshi-chat.sh（~/ 与 skill 模板双份） | 柜有 → inject.mjs 代注入后 exec；柜无 → 回落 .bashrc 提取（进柜后此分支自然死） |
| start-pianist.sh | 同 qinshi-chat 形状 |

**注意**：conductor.env 里已有的明文 key 行在下次跑 install-conductor.sh 时自动消失（重写不写 key 行）——收口时机与部署节奏合流，不需要单独动作。

## 与 T14 的关系

`.bashrc` 明文行和旧 session 里的 key 值本体是 T14 的存量泄漏面（待the user拍板轮换）。本活下线的是**增量**：新装的部署不再产生明文 env。轮换时 `.bashrc` 行删除 + `conductor.env` 重跑 install 即清空，届时 env-fallback 事件应绝迹——那两件事共用「换 key」这一个动作。

## 派活驱动器模板（skill 侧）

老路（.bashrc 提取）仍在 skill 模板里，未动——等真机验证 inject 链路稳定后切（见 SKILL.md 派活流水线第 3 步的待下线标记）。本 repo 内已无 .bashrc 提取路径。
