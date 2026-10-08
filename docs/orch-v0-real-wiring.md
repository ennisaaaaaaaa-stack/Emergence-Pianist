# orch 第一铲：真身接线（2026-10-07）

## 背景

orch-v0（f30feb7）八件套纯逻辑全绿但全是 mock：`OrchestratorEngine` 的 driver 是注入接口，
没人实现真身。本铲把「解析完的任务书→真分身进程→心跳→收尾入账」这条链用 stub pi 焊通——
**真 pi 端到端（真钱）是第二铲的事，不在本单**；验收形状=测试全程真 pi 拉起数=0
（`ORCH_PI_BIN` 指向 `node -e` 风格 stub，env 驱动行为：写 DONE/写心跳/挂死不写）。

## 新增六件（src/orchestrator/）

| 文件 | 是什么 |
|---|---|
| `driver-real.mjs` | RealDriver：spawn/sigterm/sigkill（真信号）/isAlive（pid 探活）/sendReport（拍板5 遗言文件）。conductor launchPart 钉子全抄（见下） |
| `prompt-builder.mjs` | sheet+角色 → per-minion TASK prompt；指针解引用 fail-fast 不静默；审链临时工模板（机械核对三件+占位符，拍板7） |
| `sandbox-tiers.mjs` | §9 档位表落成数据：role/沙箱列 → policyPath；enforcement 诚实报告 partial/null（轻档永不谎报 full） |
| `heartbeat.mjs` | 双源 watcher：①会话文件 mtime（发车 ±150s 锁定）②遥测 jsonl tail；mtime/事件推进才喂 beat，不轮询分身进程 |
| `runtime.mjs` | `buildRuntime({ sheetText, piBin, ... })` 组合根（拍板1）：ledger/inbox/supervisor/engine/RealDriver/watcher 在这里组装，不散装 |
| `index.mjs` | 桶文件追加导出 |

另：`sandbox/policies/no-ext-net.policy.json`（default 镜像，allowDomains=[] 空白名单=全拒，
proxyPort 8789 与 default 8788 错开防同跑冲突）；`test/orch-real-driver-test.mjs`（55 断言全绿）。

## conductor 钉子照抄清单（driver-real.mjs spawn 面）

1. **pi 入口**：piBin 以 `.mjs`/`.js` 结尾直接当入口（测试 stub 位）；缺省解析到
   `node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`——不用 `.bin/pi` 的
   shebang（`/usr/bin/env node` 拿错 PATH 里的 node）。
2. **process.execPath 起进程**：爹用哪个 node 儿子就用哪个，版本错位结构性排除
   （19连抽钉了爹漏了儿子，这次钉儿子）。
3. **钥匙供给**：`envOrVault("ZAI_CODING_CN_API_KEY", "coding-plan", `orch:${taskId}/${minionId}`)`
   ——T16 context 透传，账本记到任务级粒度（journal 落 use-vault 事件，只有名字没有值）。
4. **PIANIST_SHELL_URL**（缺省 8770）+ `no_proxy=127.0.0.1,localhost`（壳地址不走环境代理）。

## 沙箱档位（§9 表 → sandbox-tiers.mjs）

| 角色/沙箱列 | 档位 | 路径 |
|---|---|---|
| 施工分身（列缺省） | default | sandbox/policies/default.policy.json（网开） |
| 审链临时工（列缺省，含「审…临时工」短名） | no-ext-net | sandbox/policies/no-ext-net.policy.json（禁外网） |
| 查询临时工（列缺省） | default | 同施工 |
| 前台主agent | null | 不进沙箱，直接 spawn |
| 沙箱列含「禁外网/no-ext-net/闭网/断网」 | no-ext-net | 列覆盖默认档 |
| 沙箱列全等「无沙箱/不进沙箱/无/none/null」 | null | 列覆盖默认档 |

tier=null 直接 spawn；tier 有值走 `runSandboxed` 包 pi 命令（executor 可注入，测试记调用不真起沙箱）。

## 心跳双源（拍板4）

- 源①：会话目录里文件名时间戳落在发车 ±150s 窗内的 session 文件，锁定后盯 mtime；
- 源②：`data/telemetry/orch-<minionId>-<日期>.jsonl` 尾部追加的事件行（shell.mjs 落盘形状），
  逐条喂 `engine.telemetryEvent`（台账心跳+静默钟+坑账匹配全路径）；
- 推进才喂，不轮询分身进程；双源都没有→不喂，**静默钟自己会响——这正是它存在的意义**
  （阴性对照：watcher 不接，挂死分身照被 idle_timeout 收走）。
- 路径全可注入：`PIANIST_TELEMETRY_DIR` / `PIANIST_SESSIONS_DIR` / `ORCH_PROGRESS_DIR`。

## 收尾泵（runtime.mjs completionPump）

进程退场 → 机械判形状（引擎逻辑零改动，泵只调引擎公开口）：

- tail 有 `BLOCKED:歧义:…` → `reportBlocked(ambiguity)` → 台账等审+通知转前台改书；
- tail 有 `BLOCKED:环境:…` → `reportBlocked(env)` → fail-fast 讣告写明缺什么；
- code=0 且 tail 有 `DONE` → `deliver`（交货单带 floorSummary）→ 台账收；
- 信号死（signal 非 null）→ 不抢，引擎收尾链（pendingKill→finalize）管；
- 其余 → `reportSessionDeath`（进程无+协议没来=session 死亡非硬停形状）。

## v0 已知诚实降级（写明不装，第二铲的活）

1. **沙箱路径无 pid 可信号**：runSandboxed 不暴露子 pid（detached launcher 整组收割是执行器
   内部事），引擎 SIGTERM/SIGKILL 打不进去——driver 记 `killDegraded` 出声，硬停靠
   executor `timeoutMs` 兜底（runtime 按总时钟+宽限+2s 富余下传）。
2. **沙箱路径 stdout 不回收**：executor stdio=inherit，无 tail 可读——DONE 协议只对直 spawn
   生效，沙箱退场一律按 session 死亡形状入账（第二铲给沙箱路径换完成文件协议）。
3. **sendReport 是遗言提示文件**（`ORCH_PROGRESS_DIR/<minionId>.md` 一行提示）：pi -p 无 stdin，
   进程不中断——诚实降级不是假装发了信号；已存在不覆盖（分身可能已开写，别踩它）。
4. **±150s 会话锁定窗**：同 cwd 同窗并发多分身会锁到同一批文件（v0 按任务串行发车不撞；
   真并发时按 agentId 细分是第二铲）。

## 测试与验收（test/orch-real-driver-test.mjs，55 断言）

八条验收全覆盖，灵魂=阴性对照（突变由the author复验阶段亲手掰，断言结构已钉死）：

1. stub 端到端：DONE→台账收/交货单/地板摘要；spawn 拆掉→台账无行→断言必红；
2. 心跳真喂：喂着不死、停写 idle_timeout 死、**不喂也死**（监督器不依赖分身自觉）；真信号可证（stub 以 SIGTERM 退场）；
3. 钥匙 context 落账：journal 有 `orch:<taskId>/<minionId>` use-vault 事件（PORTALK_CRED_DIR/JOURNAL 全指 tmp 夹具）；
4. 沙箱档位：审链→no-ext-net（allowDomains 空）；tier=null 不经 executor；映射表改全 default→断言红；
5. 指针解引用：可读→prompt 嵌入；不可读→PromptBuildError fail-fast（不出无指针 prompt）；
6. 报告模式：80%→遗言文件+reportMode=true；不调则皆无；sendReport 幂等；
7. 零真钱：全部 spawn 入口=stub（真 pi bundle 拉起数=0）；npm test 两遍绿；
8. orch-v0-test.mjs 断言零改动仍绿（引擎一行没动）。
