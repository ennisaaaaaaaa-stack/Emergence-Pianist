// 施工⑧ 第一铲：orch 真身接线测试（RealDriver/prompt-builder/sandbox-tiers/heartbeat/runtime）。
// 纪律：真 pi 拉起数=0——ORCH_PI_BIN 全程指 node -e 风格 stub（env 驱动行为：写 DONE/写心跳/挂死不写），
//       沙箱路径走注入的记录器（不真起沙箱）；夹具全指 mkdtemp tmp（凭证/进度/遥测/会话），不写生产路径。
// 阴性对照（突变敏感，the author复验阶段亲手掰，测试里以断言结构钉住）：
//   - RealDriver.spawn 里真 spawn 调用注释掉 → 台账无行 → 「台账有行且收」断言必红；
//   - 沙箱映射表改成全 default → 审链断言（policyPath basename === no-ext-net.policy.json）必红；
//   - watcher 不启动（不喂 beat）→ 静默钟照触发（监督器不依赖分身自觉）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";

let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra !== undefined && !ok ? " — " + extra : ""}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, label) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(30); }
	return false;
}

// ---- 夹具隔离（纪律）：PORTALK_CRED_DIR/JOURNAL + ORCH_PROGRESS_DIR + 遥测/会话目录全指 tmp ----
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orch-real-driver-"));
const credDir = path.join(tmpRoot, "cred");
const journalFile = path.join(tmpRoot, "journal.jsonl");
const progressDir = path.join(tmpRoot, "progress");
const telemetryDir = path.join(tmpRoot, "telemetry");
const sessionsDir = path.join(tmpRoot, "sessions");
for (const d of [credDir, progressDir, telemetryDir, sessionsDir]) fs.mkdirSync(d, { recursive: true });
// 钥匙柜夹具：coding-plan 在柜（走 use-vault 路径，账本只有名字没有值——值永不上输出）
const V_FIXTURE = "orch-test-key-never-printed";
fs.writeFileSync(path.join(credDir, "coding-plan"), V_FIXTURE);
process.env.PORTALK_CRED_DIR = credDir;
process.env.PORTALK_CRED_JOURNAL = journalFile;
process.env.ORCH_PROGRESS_DIR = progressDir;
process.env.PIANIST_TELEMETRY_DIR = telemetryDir;
process.env.PIANIST_SESSIONS_DIR = sessionsDir;
delete process.env.ZAI_CODING_CN_API_KEY; // 剥 ambient，走柜路径（env-fallback 不是本测的路）
delete process.env.PIANIST_SHELL_URL; // 壳不在场也照样 spawn（缺省 8770 只是 env 值）

// ---- stub pi（拍板9）：.mjs 后缀直接当入口；env 驱动行为 ----
const stubPath = path.join(tmpRoot, "stub-pi.mjs");
fs.writeFileSync(stubPath, `import fs from "node:fs";
const mode = process.env.ORCH_STUB_MODE ?? "done";
const tel = process.env.ORCH_STUB_TELEMETRY ?? "";
const nBeats = Number(process.env.ORCH_STUB_BEATS ?? "0");
const beatMs = Number(process.env.ORCH_STUB_BEAT_MS ?? "90");
const beat = (i) => { if (tel) fs.appendFileSync(tel, JSON.stringify({ v: 1, ts: new Date().toISOString(), kind: "tool_use", data: { tool: "bash", input: { command: "echo beat-" + i }, isError: false } }) + "\\n"); };
if (mode === "done") {
	beat(0);
	if (tel) fs.appendFileSync(tel, JSON.stringify({ v: 1, ts: new Date().toISOString(), kind: "tool_use", data: { tool: "bash", input: { command: "npm test" }, isError: false } }) + "\\n");
	console.log("工作完成"); console.log("DONE"); process.exit(0);
} else if (mode === "blocked-env") { console.log("BLOCKED:环境: FOO_KEY 未配置"); process.exit(0); }
else if (mode === "blocked-amb") { console.log("BLOCKED:歧义: 纪律与交付物冲突，分身不当裁判"); process.exit(0); }
else if (mode === "heart") { let i = 0; setInterval(() => { i++; if (i <= nBeats) beat(i); }, beatMs); }
else { setInterval(() => {}, 1073741824); } // hang：挂死不写
`);
process.env.ORCH_PI_BIN = stubPath; // 零真钱：driver 默认入口解析必落这里

const { resolveSandboxTier, TIER_POLICY_FILES } = await import("../src/orchestrator/sandbox-tiers.mjs");
const { buildMinionPrompt, buildReviewPrompt, dereferencePointer, PromptBuildError } = await import("../src/orchestrator/prompt-builder.mjs");
const { HeartbeatWatcher } = await import("../src/orchestrator/heartbeat.mjs");
const { RealDriver } = await import("../src/orchestrator/driver-real.mjs");
const { buildRuntime } = await import("../src/orchestrator/runtime.mjs");
const { parseCastingSheet } = await import("../src/orchestrator/casting-sheet.mjs");

const allRuntimes = []; // 收尾兜底：收尸所有在场 stub
function makeRuntime(sheetText, opts = {}) {
	const rt = buildRuntime({ sheetText, piBin: stubPath, ...opts });
	allRuntimes.push(rt);
	return rt;
}

// ============ 0) 夹具自证 ============
check("夹具：stub 入口在位（.mjs 直用，真 pi bundle 不出场）", fs.existsSync(stubPath) && stubPath.endsWith(".mjs"));
check("夹具：钥匙柜有 coding-plan（走 use-vault，不走 env-fallback）", fs.existsSync(path.join(credDir, "coding-plan")));

// ============ 1) 沙箱档位映射（§9 表 + enforcement 诚实） ============
{
	const tBuild = resolveSandboxTier({ role: "施工分身" });
	check("档位：施工分身→default.policy（网开）", tBuild.tier === "default" && path.basename(tBuild.policyPath) === TIER_POLICY_FILES.default);
	const tRev = resolveSandboxTier({ role: "审链临时工" });
	const tRev2 = resolveSandboxTier({ role: "审临时工" });
	// 阴性对照结构：映射表改成全 default，此断言必红
	check("档位：审链临时工→no-ext-net.policy（短名「审临时工」同落）",
		tRev.tier === "no-ext-net" && path.basename(tRev.policyPath) === "no-ext-net.policy.json"
		&& tRev2.tier === "no-ext-net",
		JSON.stringify({ tRev: tRev.tier, tRev2: tRev2.tier }));
	const tQuery = resolveSandboxTier({ role: "查询临时工" });
	check("档位：查询临时工→default.policy", tQuery.tier === "default");
	const tFront = resolveSandboxTier({ role: "前台主agent" });
	check("档位：前台主agent→null 不进沙箱（enforcement=null）", tFront.tier === null && tFront.policyPath === null && tFront.enforcement === null);
	check("档位：enforcement 诚实=partial（轻档内核原语，永不谎报 full）",
		tBuild.enforcement === "partial" && tRev.enforcement === "partial" && tQuery.enforcement === "partial");
	// 任务书沙箱列覆盖默认档（§9「可覆盖」）
	check("档位：沙箱列「workspace-write禁外网」覆盖→no-ext-net", resolveSandboxTier({ role: "施工分身", sandbox: "workspace-write禁外网" }).tier === "no-ext-net");
	check("档位：沙箱列「无」覆盖→null", resolveSandboxTier({ role: "施工分身", sandbox: "无" }).tier === null);
	check("档位：basis 出声映射来源（列覆盖/角色表）",
		resolveSandboxTier({ role: "施工分身", sandbox: "无" }).basis.startsWith("column") && tRev.basis.startsWith("role-table"));
	// no-ext-net 策略本体：空白名单=全拒 + 端口错开防同跑冲突
	const pol = JSON.parse(fs.readFileSync(tRev.policyPath, "utf8"));
	const def = JSON.parse(fs.readFileSync(path.join(path.dirname(tRev.policyPath), TIER_POLICY_FILES.default), "utf8"));
	check("policy：no-ext-net allowDomains 空（空白名单=全拒）且 proxyPort=8789 与 default(8788) 错开",
		Array.isArray(pol.network.allowDomains) && pol.network.allowDomains.length === 0
		&& pol.network.proxyPort === 8789 && def.network.proxyPort === 8788
		&& pol.filesystem.readWrite.join() === def.filesystem.readWrite.join(), // 其余字段对齐 default
	);
	let threwPolicy = null;
	try { resolveSandboxTier({ role: "施工分身" }, { policyDir: path.join(tmpRoot, "no-such-policies") }); } catch (e) { threwPolicy = e; }
	check("档位：策略文件缺失 fail-fast（接线坏了要出声）", threwPolicy != null && /不存在/.test(threwPolicy.message));
}

// ============ 2) prompt-builder：指针解引用 + N 特例 + 审链模板 ============
const ptrFile = path.join(tmpRoot, "orch-facts.md");
fs.writeFileSync(ptrFile, "# 事实表\n- 已探明：stub 端到端链路 = 零真钱验收位\n- 坑账：node 版本错位是结构性排除项\n");
const sheetOf = (rolesBlock, extra = "") => parseCastingSheet(`# 真身接线夹具书
背景与边界：只动 test 夹具目录
预算袋：时长 30 分钟
角色表：
${rolesBlock}
交付物清单：
  - test/orch-real-driver-test.mjs 全绿
验收标准：
  - stub 端到端收工
纪律：
  - 不 commit 留工作区
${extra}`);
{
	const sheet = sheetOf(`  - 角色:施工分身 | 数量:3 | 沙箱:无 | 指针:${ptrFile}`);
	const p2 = buildMinionPrompt({ sheet, roleEntry: sheet.roles[0], taskId: "t-p", minionId: "m-p2", index: 2 });
	check("prompt：N>1 标「第 i/共 N」", p2.includes("共 3 个实例") && p2.includes("你是第 2 个"));
	const pRetry = buildMinionPrompt({ sheet, roleEntry: sheet.roles[0], taskId: "t-p", minionId: "m-p1r", index: 1, workaround: "换随机端口重试", failureReason: "known_pit:pit-eaddrinuse" });
	check("prompt：重试注入段（workaround+失败原因作重试输入）", pRetry.includes("换随机端口重试") && pRetry.includes("known_pit:pit-eaddrinuse"));
	const n1sheet = sheetOf(`  - 角色:施工分身 | 沙箱:无 | 指针:${ptrFile}`);
	const p1 = buildMinionPrompt({ sheet: n1sheet, roleEntry: n1sheet.roles[0], taskId: "t-p", minionId: "m-p1", index: 1 });
	check("prompt：N=1 特例不说废话（无「共 N 个实例」），指针内容嵌入",
		!p1.includes("个实例") && p1.includes("已探明：stub 端到端链路") && p1.includes(ptrFile));
	check("prompt：收工协议在（DONE/BLOCKED 双路）", /`DONE`/.test(p1) && /`BLOCKED:歧义/.test(p1) && /`BLOCKED:环境/.test(p1));
	// 指针不可读 → fail-fast 不静默（不弘扬「没有指针的裸奔 prompt」）
	let threwPtr = null;
	try { dereferencePointer(path.join(tmpRoot, "no-such-facts.md")); } catch (e) { threwPtr = e; }
	check("指针：不存在路径 fail-fast（报具体路径，不静默出无指针 prompt）",
		threwPtr instanceof PromptBuildError && threwPtr.message.includes("no-such-facts.md") && threwPtr.message.includes("fail-fast"));
	let threwEmpty = null;
	try { dereferencePointer("   "); } catch (e) { threwEmpty = e; }
	check("指针：空指针拒绝", threwEmpty instanceof PromptBuildError);
	// 审链模板（拍板7：模板+占位符即交付）
	const rp = buildReviewPrompt({ taskId: "t-r", revieweeId: "m-build" });
	check("审链模板：机械核对三件+VERDICT 协议+阴性对照纪律",
		rp.includes("源可达") && rp.includes("引用对得上") && rp.includes("两遍") && rp.includes("VERDICT:pass") && rp.includes("绿灯盖章机"));
	const rpBare = buildReviewPrompt({ taskId: "t-r" }); // 全占位形态：没填就派=审链空转，调用方负责
	check("审链模板：占位符在位（不传则 <被审对象>/<证据指针>/<revieweeId> 字面量留场）",
		rpBare.includes("<被审对象") && rpBare.includes("<证据指针") && rpBare.includes("<revieweeId>"));
	const rpFilled = buildReviewPrompt({ taskId: "t-r", revieweeId: "m-build", subject: "src/x.mjs", claims: ["结论A：零真钱"] });
	check("审链模板：实参填充（复验者≠施工者点名被审者）", rpFilled.includes("src/x.mjs") && rpFilled.includes("结论A：零真钱") && rpFilled.includes("m-build"));
}

// ============ 3) watcher 双源单测：session mtime ±150s 锁定 + 遥测 tail ============
{
	const T = Date.parse("2026-10-07T06:00:00.000Z");
	const sessName = (ms) => new Date(ms).toISOString().replace(/[:.]/g, "-").replace(/(\d{2})-(\d{3})Z$/, "$1-$2Z") + "_deadbeef.jsonl";
	const inWin = path.join(sessionsDir, sessName(T + 60_000)); // 发车 +60s：窗口内
	const outWin = path.join(sessionsDir, sessName(T + 400_000)); // +400s：窗外不锁
	fs.writeFileSync(inWin, "{\"type\":\"session\"}\n");
	fs.writeFileSync(outWin, "{\"type\":\"session\"}\n");
	fs.utimesSync(inWin, new Date(T), new Date(T));
	const beats = [];
	const w = new HeartbeatWatcher({ onBeat: (id, ev) => beats.push({ id, ev }) });
	w.watch("m-sess", { spawnAt: T, sessionDir: sessionsDir, telemetryFile: null });
	check("watcher：session 锁定=发车 ±150s 窗口内文件（窗外不锁）", w.locked("m-sess").includes(inWin) && !w.locked("m-sess").includes(outWin));
	check("watcher：mtime 未推进不喂 beat", w.poll().length === 0);
	fs.utimesSync(inWin, new Date(T + 5_000), new Date(T + 5_000));
	const b1 = w.poll();
	check("watcher：session mtime 推进→喂 beat（kind=session_mtime）",
		b1.length === 1 && b1[0].source === "session" && b1[0].ev.kind === "session_mtime" && Date.parse(b1[0].ev.ts) === T + 5_000);
	check("watcher：beat 幂等（重复 poll 不重复喂）", w.poll().length === 0);
	// 遥测 tail：完整行逐条喂；截断尾行攒着拼；坏行跳过
	const telFile = path.join(telemetryDir, "watcher-tail-test.jsonl");
	fs.writeFileSync(telFile, "");
	w.watch("m-tel", { spawnAt: T, telemetryFile: telFile, sessionDir: null });
	fs.appendFileSync(telFile, JSON.stringify({ v: 1, ts: new Date(T + 1000).toISOString(), kind: "tool_use", data: { tool: "read" } }) + "\n");
	fs.appendFileSync(telFile, "{\"v\":1,\"ts\":\"x"); // 截断尾（死流形状）
	let b2 = w.poll();
	check("watcher：遥测 tail 完整行喂 beat、截断尾不喂", b2.length === 1 && b2[0].ev.data.tool === "read");
	fs.appendFileSync(telFile, "\",\"kind\":\"message_end\"}\n" + "{ 坏行\n");
	b2 = w.poll();
	check("watcher：截断行拼齐后喂、坏行跳过不炸", b2.length === 1 && b2[0].ev.kind === "message_end");
	w.stop();
}

// ============ 4) stub 端到端（验收1）：fixture 任务书→buildRuntime→真 spawn stub→DONE→收尾入账 ============
{
	const sheetText = `# 真身接线端到端
背景与边界：只动 test 夹具目录；零真钱
预算袋：时长 30 分钟
角色表：
  - 角色:施工分身 | 数量:1 | 沙箱:无 | 指针:${ptrFile}
交付物清单：
  - test/orch-real-driver-test.mjs 全绿
验收标准：
  - stub 端到端收工、台账收、地板摘要出文本
纪律：
  - 不 commit 留工作区`;
	process.env.ORCH_STUB_MODE = "done";
	process.env.ORCH_STUB_TELEMETRY = path.join(telemetryDir, `orch-m-e2e-${new Date().toISOString().slice(0, 10)}.jsonl`);
	const rt = makeRuntime(sheetText, { supervisorCfg: { timeoutMs: 60_000 } });
	const rec = rt.launchMinion({ taskId: "t-e2e", role: "施工分身", minionId: "m-e2e" });
	// spawn 钉子全检：entry=stub（零真钱）、直 spawn（tier null）、pid 在手、execPath 起进程
	check("端到端：真 spawn stub（pid 在手、tier=null 直接 spawn、entry=stub 非真 pi bundle）",
		Number.isInteger(rec.pid) && rec.pid > 0 && rec.sandboxed === false && rec.tier === null && rec.entry === stubPath);
	const exit = await rt.driver.rows.get("m-e2e").closed;
	check("端到端：stub 退场 code=0 且 tail 含 DONE", exit.code === 0 && /DONE/.test(exit.tail));
	const row = rt.ledger.get("m-e2e");
	const item = rt.inbox.peek();
	check("端到端：台账「收」+ 收件箱交货单 + 地板摘要出文本（testStatus/currentTool 从遥测机械抽取）",
		row.status === "收" && item?.kind === "交货单" && item.payload.minionId === "m-e2e"
		&& item.payload.manifest.floorSummary?.testStatus === "green"
		&& item.payload.manifest.floorSummary?.currentTool === "bash"
		&& item.payload.manifest.tail.includes("DONE"),
		JSON.stringify({ status: row.status, kind: item?.kind, floor: item?.payload?.manifest?.floorSummary }));
	rt.pollBeats(); // stub 写过的遥测行这轮喂进引擎（事件推进才喂）
	check("端到端：心跳真喂进台账（lastTool/lastHeartbeat 登记自遥测 tail）",
		rt.ledger.get("m-e2e").lastTool === "bash" && rt.ledger.get("m-e2e").lastHeartbeat != null);
	// 阴性对照结构（the author复验亲手掰：把 RealDriver.spawn 里真 spawn 注释掉）：
	//   无进程→无 closed/DONE→无 deliver→本组「台账收/交货单」断言必红——台账无行这个形状被钉死在这。
	check("端到端：台账有行（spawn 拆掉则无行，此断言红）", rt.ledger.get("m-e2e") != null);
}

// ============ 5) BLOCKED 双路（收尾泵：歧义→等审+通知；环境→死+讣告） ============
{
	process.env.ORCH_STUB_TELEMETRY = "";
	const sheetText = `# BLOCKED 双路
背景与边界：夹具
预算袋：时长 10 分钟
角色表：
  - 角色:施工分身 | 数量:1 | 沙箱:无
交付物清单：
  - 无
验收标准：
  - BLOCKED 路各归各的账
纪律：
  - 不 commit`;
	const rt = makeRuntime(sheetText, { supervisorCfg: { timeoutMs: 60_000 } });
	process.env.ORCH_STUB_MODE = "blocked-env";
	rt.launchMinion({ taskId: "t-blk", role: "施工分身", minionId: "m-benv" });
	await rt.driver.rows.get("m-benv").closed;
	const obEnv = rt.inbox.peek();
	check("BLOCKED·环境：台账死+讣告写明缺什么（FOO_KEY）",
		rt.ledger.get("m-benv").status === "死" && obEnv?.kind === "讣告" && obEnv.payload.cause === "环境" && obEnv.payload.causeDetail.includes("FOO_KEY"));
	process.env.ORCH_STUB_MODE = "blocked-amb";
	rt.launchMinion({ taskId: "t-blk", role: "施工分身", minionId: "m-bamb" });
	await rt.driver.rows.get("m-bamb").closed;
	const obAmb = rt.inbox.items.find((i) => i.payload.minionId === "m-bamb");
	check("BLOCKED·歧义：台账等审+通知转前台改书（分身不当裁判）",
		rt.ledger.get("m-bamb").status === "等审" && obAmb?.kind === "通知" && obAmb.payload.reason.includes("转前台改书"));
}

// ============ 6) 钥匙 context 落账（验收3：orch:<taskId>/<minionId> 任务级粒度） ============
{
	process.env.ORCH_STUB_MODE = "done";
	const sheetText = `# 钥匙落账
背景与边界：夹具
预算袋：时长 10 分钟
角色表：
  - 角色:查询临时工 | 数量:1 | 沙箱:无
交付物清单：
  - 无
验收标准：
  - journal 有任务级 context
纪律：
  - 不 commit`;
	const rt = makeRuntime(sheetText, { supervisorCfg: { timeoutMs: 60_000 } });
	rt.launchMinion({ taskId: "t-key", role: "查询临时工", minionId: "m-key" });
	await rt.driver.rows.get("m-key").closed;
	const lines = fs.existsSync(journalFile) ? fs.readFileSync(journalFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
	const use = lines.filter((l) => l.action === "use-vault" && l.context === "orch:t-key/m-key");
	check("钥匙：spawn 后 journal 落 use-vault 事件（context=orch:t-key/m-key 任务级粒度）",
		use.length >= 1 && use.every((l) => l.name === "coding-plan"),
		JSON.stringify(lines.map((l) => ({ a: l.action, c: l.context }))));
	check("钥匙：账本只有名字没有值（夹具值永不上账）", !fs.readFileSync(journalFile, "utf8").includes(V_FIXTURE));
}

// ============ 7) 心跳真喂 + 静默钟（验收2，真时钟）：喂着不死、停写必死、不喂也必死 ============
{
	const sheetText = `# 心跳链
背景与边界：夹具
预算袋：时长 10 分钟
角色表：
  - 角色:施工分身 | 数量:1 | 沙箱:无
交付物清单：
  - 无
验收标准：
  - 心跳真喂；静默钟两路都响
纪律：
  - 不 commit`;
	// stub：先写 12 拍（每 90ms）然后挂死不写；阴性对照分身：从一开始就挂死不写且不接 watcher
	process.env.ORCH_STUB_MODE = "heart";
	process.env.ORCH_STUB_BEATS = "12";
	process.env.ORCH_STUB_BEAT_MS = "90";
	process.env.ORCH_STUB_TELEMETRY = path.join(telemetryDir, `orch-m-heart-${new Date().toISOString().slice(0, 10)}.jsonl`);
	// 静默钟 1500ms（宽于 stub 启动+拍间隔的抖动，防负载误杀——「设值必须高于最慢单次工具调用」同族自律）
	const rt = makeRuntime(sheetText, { supervisorCfg: { idleTimeoutMs: 1500, graceMs: 600 } }); // 无总时钟，单设静默钟
	rt.launchMinion({ taskId: "t-hb", role: "施工分身", minionId: "m-heart" });
	process.env.ORCH_STUB_MODE = "hang";
	rt.launchMinion({ taskId: "t-hb", role: "施工分身", minionId: "m-nowatch", watch: false }); // 阴性对照：watcher 不接
	// 活跃窗（~1s < idle 1500ms）：分身在写心跳 → 谁都不许死
	for (let i = 0; i < 10; i++) { rt.pollBeats(); rt.tick(Date.now()); await sleep(60); }
	check("心跳：喂着不死（stub 在写心跳期间静默钟不触发，两分身都在飞）",
		rt.ledger.get("m-heart").status === "跑" && rt.ledger.get("m-nowatch").status === "跑"
		&& rt.ledger.get("m-heart").lastHeartbeat != null && rt.ledger.get("m-heart").lastTool === "bash",
		JSON.stringify({ h: rt.ledger.get("m-heart"), n: rt.ledger.get("m-nowatch") }));
	// 放钟走：m-nowatch（无心跳）约 spawn+1500ms 死；m-heart 停写后约 12×90+1500ms 死
	const bothDead = await waitFor(() => { rt.pollBeats(); rt.tick(Date.now()); return rt.ledger.get("m-heart").status === "死" && rt.ledger.get("m-nowatch").status === "死"; }, 10_000);
	check("心跳：停写→静默钟触发→SIGTERM→台账死（死因 idle_timeout）", bothDead
		&& rt.ledger.get("m-heart").note.includes("idle-timeout"),
		JSON.stringify({ h: rt.ledger.get("m-heart")?.status, n: rt.ledger.get("m-nowatch")?.status }));
	check("心跳：真信号可证（stub 进程以 SIGTERM 退场——close 事件带回 signal）",
		rt.driver.rows.get("m-heart").exit?.signal === "SIGTERM" && rt.driver.rows.get("m-nowatch").exit?.signal === "SIGTERM");
	const obs = rt.inbox.peekAll().filter((i) => i.kind === "讣告");
	check("心跳：讣告送达（死因明细写静默钟）",
		obs.length === 2 && obs.every((o) => o.payload.cause === "超时" && o.payload.causeDetail.includes("idle-timeout")),
		JSON.stringify(obs.map((o) => [o.payload.minionId, o.payload.cause])));
	// 阴性对照本尊：m-nowatch 从未被喂过一个 beat（lastHeartbeat 仍空）却照死——监督器不依赖分身自觉
	check("心跳·阴性对照：watcher 不启动（不喂 beat）→静默钟照触发（无心跳也死，且台账全程无心跳记录）",
		rt.ledger.get("m-nowatch").lastHeartbeat === null && rt.ledger.get("m-nowatch").status === "死");
}

// ============ 8) 沙箱档位接线（验收4）：审链→runSandboxed no-ext-net；tier=null 不经 executor ============
{
	const calls = [];
	const recordingExecutor = async (o) => { calls.push(o); return { code: 0, signal: null, journaledHosts: [] }; };
	const sheetText = `# 沙箱档位
背景与边界：夹具
预算袋：时长 10 分钟
角色表：
  - 角色:审链临时工 | 数量:1
  - 角色:施工分身 | 数量:1 | 沙箱:无
  - 角色:查询临时工 | 数量:1
交付物清单：
  - 无
验收标准：
  - 档位映射接线正确
纪律：
  - 不 commit`;
	process.env.ORCH_STUB_MODE = "done";
	process.env.ORCH_STUB_TELEMETRY = "";
	const rt = makeRuntime(sheetText, { supervisorCfg: { timeoutMs: 60_000 }, runSandboxed: recordingExecutor });
	rt.launchMinion({ taskId: "t-sbx", role: "审链临时工", minionId: "m-rev" });
	await rt.driver.rows.get("m-rev").closed; // 沙箱路径异步发车（runSandboxed 微 task 后才出手）——等结算再断言
	// 阴性对照结构：映射表改成全 default → basename 断言红
	check("沙箱：审链临时工→runSandboxed 且 policyPath=no-ext-net.policy.json（allowDomains 空）",
		calls.length === 1 && path.basename(calls[0].policyPath) === "no-ext-net.policy.json"
		&& JSON.parse(fs.readFileSync(calls[0].policyPath, "utf8")).network.allowDomains.length === 0
		&& rt.ledger.get("m-rev").sandboxTier === "no-ext-net",
		JSON.stringify(calls.map((c) => c.policyPath)));
	check("沙箱：包的是 pi 命令（execPath 起 + stub 入口 + agent 工牌=minionId + 钥匙进沙箱 env）",
		calls[0].command[0] === process.execPath && calls[0].command[1] === stubPath
		&& calls[0].agent === "m-rev" && calls[0].env.PIANIST_AGENT_ID === "orch-m-rev"
		&& calls[0].env.ZAI_CODING_CN_API_KEY === fs.readFileSync(path.join(credDir, "coding-plan"), "utf8"),
		JSON.stringify({ cmd0: calls[0]?.command?.[0], cmd1: calls[0]?.command?.[1] }));
	const before = calls.length;
	const recDirect = rt.launchMinion({ taskId: "t-sbx", role: "施工分身", minionId: "m-direct" });
	await rt.driver.rows.get("m-direct").closed;
	check("沙箱：tier=null（沙箱:无）直接 spawn 不经 executor（断言沙箱包装缺席）",
		calls.length === before && recDirect.sandboxed === false && Number.isInteger(recDirect.pid));
	rt.launchMinion({ taskId: "t-sbx", role: "查询临时工", minionId: "m-q" });
	await waitFor(() => rt.driver.rows.get("m-q")?.done === true, 3000);
	check("沙箱：查询临时工→default.policy（网开）", calls.length === 2 && path.basename(calls[1].policyPath) === TIER_POLICY_FILES.default);
	// v0 已知诚实面：沙箱路径 stdout 不回收（executor stdio=inherit），无 DONE 可读 → 收尾泵按 session 死亡形状入账
	await waitFor(() => rt.ledger.get("m-rev").status !== "跑", 3000);
	check("沙箱：沙箱路径退场→讣告（v0 无 tail 可读，按 session 死亡诚实入账不装 DONE）",
		rt.ledger.get("m-rev").status === "死" && rt.inbox.items.some((i) => i.kind === "讣告" && i.payload.minionId === "m-rev"));
}

// ============ 9) 指针解引用经 runtime（验收5）：可读→prompt 嵌入；不可读→fail-fast 不出无指针 prompt ============
{
	const okSheet = `# 指针正路
背景与边界：夹具
预算袋：时长 10 分钟
角色表：
  - 角色:施工分身 | 数量:1 | 沙箱:无 | 指针:${ptrFile}
交付物清单：
  - 无
验收标准：
  - 指针嵌入
纪律：
  - 不 commit`;
	process.env.ORCH_STUB_MODE = "done";
	const rtOk = makeRuntime(okSheet, { supervisorCfg: { timeoutMs: 60_000 } });
	rtOk.launchMinion({ taskId: "t-ptr", role: "施工分身", minionId: "m-ptr" });
	await rtOk.driver.rows.get("m-ptr").closed;
	check("指针：指到 fixture 文件→spawn 的 TASK prompt 含指针内容", rtOk.driver.get("m-ptr").prompt.includes("已探明：stub 端到端链路"));
	const badSheet = okSheet.replace(ptrFile, path.join(tmpRoot, "no-such-facts.md"));
	const rtBad = makeRuntime(badSheet, { supervisorCfg: { timeoutMs: 60_000 } });
	let threw = null;
	try { rtBad.launchMinion({ taskId: "t-ptr", role: "施工分身", minionId: "m-ptr-bad" }); } catch (e) { threw = e; }
	check("指针：指到不存在路径→launch fail-fast（PromptBuildError，不出无指针 prompt）",
		threw instanceof PromptBuildError && threw.message.includes("no-such-facts.md"));
	check("指针：fail-fast 后不spawn不登账（台账无行、驱动器无进程）",
		rtBad.ledger.get("m-ptr-bad") === null && rtBad.driver.get("m-ptr-bad") === null);
}

// ============ 10) 报告模式（验收6，假时钟）：80% 转报告→遗言文件+台账 reportMode；不调则皆无 ============
{
	const T0 = 1_700_000_000_000;
	const sheetText = `# 报告模式
背景与边界：夹具
预算袋：时长 10 分钟
角色表：
  - 角色:施工分身 | 数量:1 | 沙箱:无
交付物清单：
  - 无
验收标准：
  - 80% 阈值转报告模式
纪律：
  - 不 commit`;
	process.env.ORCH_STUB_MODE = "hang"; // 挂死不写，等着被总时钟收
	const rt = makeRuntime(sheetText, { supervisorCfg: { timeoutMs: 10_000, graceMs: 5_000 }, now: () => T0 });
	rt.launchMinion({ taskId: "t-rep", role: "施工分身", minionId: "m-rep" });
	rt.tick(T0 + 5_000); // 50%：不到 80%，不许有任何报告面动作
	check("报告模式：未到 80% → 遗言文件不出、reportMode=false",
		!fs.existsSync(path.join(progressDir, "m-rep.md")) && rt.ledger.get("m-rep").reportMode === false);
	rt.tick(T0 + 8_000); // 80%：转报告模式
	const repFile = path.join(progressDir, "m-rep.md");
	check("报告模式：80% → 遗言提示文件出现（一行「转报告模式」提示）+ 台账 reportMode=true",
		fs.existsSync(repFile) && fs.readFileSync(repFile, "utf8").includes("转报告模式") && rt.ledger.get("m-rep").reportMode === true);
	rt.driver.sendReport("m-rep"); // 幂等：已存在不覆盖（分身可能已开写遗言，别踩它）
	check("报告模式：sendReport 幂等（不重复写提示行）", fs.readFileSync(repFile, "utf8").split("\n").filter(Boolean).length === 1);
	// 对照分身（另一 runtime）：不走到 80% → 不调 sendReport → 文件与 reportMode 皆无
	const rt2 = makeRuntime(sheetText, { supervisorCfg: { timeoutMs: 10_000, graceMs: 5_000 }, now: () => T0 });
	rt2.launchMinion({ taskId: "t-rep2", role: "施工分身", minionId: "m-norep" });
	rt2.tick(T0 + 7_000);
	check("报告模式·阴性对照：不调 sendReport → 遗言文件与 reportMode 皆无",
		!fs.existsSync(path.join(progressDir, "m-norep.md")) && rt2.ledger.get("m-norep").reportMode === false);
	// 三级收尾真信号收尸：到点 SIGTERM（挂死 stub 真死）→ 宽限 → SIGKILL → 台账死
	rt.tick(T0 + 10_000);
	await waitFor(() => rt.driver.rows.get("m-rep").done === true, 3000);
	rt.tick(T0 + 15_500);
	const row = rt.ledger.get("m-rep");
	check("报告模式：到点三级收尾（SIGTERM 真杀挂死 stub→台账死·超时讣告）",
		row.status === "死" && rt.driver.rows.get("m-rep").exit?.signal === "SIGTERM"
		&& rt.inbox.items.some((i) => i.kind === "讣告" && i.payload.minionId === "m-rep" && i.payload.cause === "超时"));
}

// ============ 11) 零真钱（验收7）：全程真 pi 拉起数=0 ============
{
	let spawned = 0, stubs = 0;
	for (const rt of allRuntimes) {
		for (const [id, rec] of rt.driver.rows) {
			spawned++;
			if (rec.entry === stubPath) stubs++;
		}
	}
	check(`零真钱：全部 ${spawned} 次 spawn 的入口都是 stub（真 pi bundle 拉起数=0）`, spawned > 0 && spawned === stubs);
}

// ---- 收尾兜底：收尸一切在场 stub 进程（不许测试进程留下孤儿子进程） ----
for (const rt of allRuntimes) {
	rt.stopWatching();
	for (const [id, rec] of rt.driver.rows) {
		if (!rec.done && Number.isInteger(rec.pid)) { try { process.kill(rec.pid, "SIGKILL"); } catch { /* 已死 */ } }
	}
}
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
