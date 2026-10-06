// 施工⑧ orch-v0 骨架测试：casting sheet 解析/lint、spawn 台账、双时钟监督器、
// 失败语义七行全表、讣告三源、地板摘要、前台收件箱。
// 纪律：全部假驱动器（mock driver）+ fixture 遥测流/会话原文，真 spawn 数量=0；
//       环境隔离照 repo 惯例——CLEAN_ENV 剥净 CONDUCTOR_*，遥测目录指 mkdtemp 临时目录。
// 阴性对照（突变敏感）：
//   - 拆掉双时钟监督（不监督配置）→ 永跑假分身无人收：监督测试组靠超时链断言活着，拆了必红；
//   - lint 双向：冲突任务书必出 finding，干净任务书必零 finding；
//   - 讣告拆掉遥测源 → 输出必标「遥测源缺失」，不许照常出完整讣告。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { parseCastingSheet, CastingSheetError } from "../src/orchestrator/casting-sheet.mjs";
import { runLint, lintSheet } from "../src/orchestrator/lint.mjs";
import { SpawnLedger } from "../src/orchestrator/ledger.mjs";
import { Inbox } from "../src/orchestrator/inbox.mjs";
import { floorSummaryFromEvents, floorSummaryFromFile } from "../src/orchestrator/floor-summary.mjs";
import { DualClockSupervisor, parseTimeoutValue, validateSupervisorConfig, TimeoutConfigError } from "../src/orchestrator/supervisor.mjs";
import { generateObituary } from "../src/orchestrator/obituary.mjs";
import { OrchestratorEngine, FAILURE_SEMANTICS_TABLE } from "../src/orchestrator/failure-semantics.mjs";

let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra !== undefined && !ok ? " — " + extra : ""}`); }

// ---- 环境隔离（repo 纪律）：剥净 CONDUCTOR_*，头顶灌假 ambient 自证密封 ----
Object.assign(process.env, { CONDUCTOR_EVENT_TABLE: "ambient-seal-probe", CONDUCTOR_DAILY_BUDGET: "77" });
const CLEAN_ENV = { ...process.env };
for (const k of Object.keys(CLEAN_ENV)) if (/^CONDUCTOR_/.test(k)) delete CLEAN_ENV[k];
check("CLEAN_ENV 剥净 CONDUCTOR_*（含密封探针）", !Object.keys(CLEAN_ENV).some((k) => /^CONDUCTOR_/.test(k)));

// 遥测目录指 mkdtemp 临时目录（fixture 落这里）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "orch-v0-test-"));
const telDir = path.join(tmpDir, "telemetry");
fs.mkdirSync(telDir, { recursive: true });

const T0 = 1_000_000_000_000; // 假时基
const iso = (ms) => new Date(ms).toISOString();

// ============ 1) casting sheet 解析器 ============
const VALID_SHEET = `# orch-v0 骨架施工

背景与边界：只动 src/orchestrator/ 与 test/ 下新增文件；不动 conductor.mjs。
预算袋：时长 30 分钟，金额 $2
角色表：
  - 角色:施工分身 | 数量:2 | 沙箱:workspace-write | 指针:docs/orch-facts.md
  - 角色:审临时工 | 数量:1 | 沙箱:workspace-write禁外网 | 验收:七形状全绿+阴性对照
交付物清单：
  - src/orchestrator/index.mjs
  - test/orch-v0-test.mjs
验收标准：
  - 七种失败形状各有测试用例且断言台账迁移+收件箱类型
  - npm test 全绿
纪律：
  - 不 commit 留工作区
  - 仓外动作报备`;

let sheet = null;
try { sheet = parseCastingSheet(VALID_SHEET); } catch (e) { console.log("parse error:", e.message); }
check("解析：标题", sheet?.name === "orch-v0 骨架施工");
check("解析：角色表两行（角色/数量/沙箱/指针/验收）",
	sheet?.roles?.length === 2
	&& sheet.roles[0].role === "施工分身" && sheet.roles[0].count === 2
	&& sheet.roles[0].sandbox === "workspace-write" && sheet.roles[0].pointer === "docs/orch-facts.md"
	&& sheet.roles[1].role === "审临时工" && sheet.roles[1].count === 1 && sheet.roles[1].acceptance?.includes("阴性对照"));
check("解析：预算袋（金额+时长两项）", sheet?.budget?.money === 2 && sheet?.budget?.durationMs === 30 * 60_000);
check("解析：交付物/验收/纪律段", sheet?.deliverables?.length === 2 && sheet?.acceptance?.length === 2 && sheet?.disciplines?.length === 2);

function expectReject(name, text, mustMention) {
	let err = null;
	try { parseCastingSheet(text); } catch (e) { err = e; }
	check(name, err instanceof CastingSheetError && err.message.includes(mustMention), err ? err.message : "未拒绝");
}
const strip = (name) => VALID_SHEET.split("\n").filter((l) => !l.startsWith(name) && !(name === "角色表" && l.trim().startsWith("- 角色:"))).join("\n");
expectReject("解析拒绝：缺角色表（报具体缺什么）", strip("角色表"), "角色表");
expectReject("解析拒绝：缺预算袋", strip("预算袋"), "预算袋");
expectReject("解析拒绝：缺验收标准", VALID_SHEET.split("\n").filter((l) => !l.startsWith("验收标准") && !l.startsWith("  - 七种")).join("\n"), "验收标准");
expectReject("解析拒绝：预算袋三项全空", VALID_SHEET.replace("时长 30 分钟，金额 $2", "随缘"), "预算袋为空");

// N=1 特例：单分身任务书同样走角色表（统一格式，无旧格式兼容）
const n1 = parseCastingSheet(`# 单铲小活
预算袋：token 50k
角色表：
  - 角色:施工分身 | 沙箱:workspace-write | 指针:docs/facts.md
交付物清单：
  - src/orchestrator/x.mjs
验收标准：
  - 有测试`);
check("解析：N=1 特例走角色表，数量缺省=1", n1.roles.length === 1 && n1.roles[0].count === 1 && n1.budget.tokens === 50_000);

// ============ 2) 任务书 lint（advisory） ============
const DIRTY_SHEET = `# 冲突书
预算袋：时长 10 分钟
角色表：
  - 角色:施工分身 | 沙箱:workspace-write | 指针:docs/f.md
交付物清单：
  - src/orchestrator/a.mjs
  - test/outside.mjs
验收标准：
  - 全绿
纪律：
  - 只动 src/orchestrator/ 下的文件`;
const dirty = runLint(DIRTY_SHEET, { strict: true });
check("lint：纪律×交付物冲突必出 finding（阴性对照A）",
	dirty.findings.some((f) => f.rule === "discipline-deliverable-conflict" && f.severity === "high" && f.message.includes("test/outside.mjs")),
	JSON.stringify(dirty.findings));
check("lint：严格模式见高危 → 退出码 1", dirty.exitCode === 1);

const CLEAN_LINT_SHEET = DIRTY_SHEET.replace("  - test/outside.mjs\n", "");
const cleanLint = runLint(CLEAN_LINT_SHEET, { strict: true });
check("lint：干净任务书零 finding（阴性对照B·双向）", cleanLint.findings.length === 0 && cleanLint.exitCode === 0,
	JSON.stringify(cleanLint.findings));

const npmTestSheet = runLint(`# 测试链书
预算袋：时长 10 分钟
角色表：
  - 角色:施工分身
交付物清单：
  - src/a.mjs 挂 npm test 链
验收标准：
  - npm test 全绿
纪律：
  - 不 commit`);
check("lint：挂 npm test 链 → 硬停时长预估提醒", npmTestSheet.findings.some((f) => f.rule === "npm-test-hard-stop-estimate" && f.severity === "medium"));

check("lint：advisory 默认不拦（高危非严格 → 0）", runLint(DIRTY_SHEET).exitCode === 0);
check("lint：空输入 → 退出码 2（lint 坏了要出声）", runLint("").exitCode === 2 && runLint("").findings[0].severity === "error");
check("lint：喂解析不过的垃圾 → 2 不是静默", runLint("hello world").exitCode === 2);

// ============ 3) spawn 台账 ============
const ledger = new SpawnLedger();
ledger.register({ id: "m-1", role: "施工分身", sheetId: "sheet-1", startedAt: T0 });
ledger.register({ id: "m-2", role: "审临时工", sheetId: "sheet-1", startedAt: T0 });
ledger.register({ id: "m-3", role: "查询临时工", sheetId: "sheet-2", startedAt: T0 });
ledger.setStatus("m-3", "死");
const h1 = ledger.registerHeartbeat("m-1", { ts: iso(T0 + 5_000), kind: "tool_use", tool: "read" });
check("台账：registerHeartbeat 后最后心跳登记", h1.ok && h1.row.lastHeartbeat === iso(T0 + 5_000) && h1.row.lastTool === "read");
const h2 = ledger.registerHeartbeat("m-1", { ts: iso(T0 + 9_000), kind: "tool_use", tool: "bash" });
check("台账：再次心跳 → 最后心跳字段变化", h2.row.lastHeartbeat === iso(T0 + 9_000) && h2.row.lastHeartbeat !== h1.row.lastHeartbeat);
const printed = ledger.print({ now: T0 + 20_000 });
check("台账：一键打印含全部在飞（m-1/m-2 在飞，m-3 已死）",
	printed.includes("m-1") && printed.includes("m-2") && printed.includes("状态=跑") && /在飞 2/.test(printed));
check("台账：未知 id 心跳不炸，出声", ledger.registerHeartbeat("nope", { ts: iso(T0) }).ok === false);
check("台账：非法状态拒绝", (() => { try { ledger.setStatus("m-1", "躺着"); return false; } catch { return true; } })());

// ============ 4) 前台收件箱：FIFO ============
const inbox = new Inbox();
inbox.deliver("通知", { reason: "第1条" });
inbox.deliver("交货单", { manifest: "第2条" });
inbox.deliver("讣告", { cause: "第3条" });
const r1 = inbox.read(), r2 = inbox.read(), r3 = inbox.read();
check("收件箱：FIFO 先进先出", r1.kind === "通知" && r2.kind === "交货单" && r3.kind === "讣告" && r1.payload.reason === "第1条" && r3.payload.cause === "第3条");
check("收件箱：读空 → null", inbox.read() === null && inbox.size() === 0);
check("收件箱：非法送达物类型拒绝", (() => { try { inbox.deliver("快递"); return false; } catch { return true; } })());

// ============ 5) 地板摘要器（零 LLM 机械抽取） ============
const fixtureEvents = [
	{ v: 1, ts: iso(T0 + 1000), agent: "m-x", kind: "tool_use", data: { tool: "read", input: { path: "/repo/docs/a.md" }, isError: false } },
	{ v: 1, ts: iso(T0 + 2000), agent: "m-x", kind: "tool_use", data: { tool: "edit", input: { path: "/repo/src/b.mjs" }, isError: false } },
	{ v: 1, ts: iso(T0 + 3000), agent: "m-x", kind: "tool_use", data: { tool: "bash", input: { command: "npm test" }, isError: true } },
	{ v: 1, ts: iso(T0 + 4000), agent: "m-x", kind: "tool_use", data: { tool: "bash", input: { command: "npm test" }, isError: false } },
	{ v: 1, ts: iso(T0 + 5000), agent: "m-x", kind: "message_end", data: { usage: {} } },
];
const floor = floorSummaryFromEvents(fixtureEvents);
check("地板：当前工具/文件/红绿/时间戳", floor.currentTool === "bash"
	&& floor.filesTouched.join() === "/repo/docs/a.md,/repo/src/b.mjs"
	&& floor.testStatus === "green" && floor.testRunCount === 2 && floor.lastEventTs === iso(T0 + 5000));
const redFloor = floorSummaryFromEvents(fixtureEvents.slice(0, 3));
check("地板：测试以最后一次跑为准（前面红→截断后红）", redFloor.testStatus === "red");

// fixture jsonl 落 mkdtemp 遥测目录（含截断尾行——死分身的流就是这个形状）
const telFile = path.join(telDir, "m-dead-20261006.jsonl");
fs.writeFileSync(telFile, fixtureEvents.map((e) => JSON.stringify(e)).join("\n") + "\n{\"v\":1,\"ts\":\"trunc");
const floorFile = floorSummaryFromFile(telFile);
check("地板：从文件吃流，截断坏行跳过仍出摘要（死掉的分身也有地板）",
	floorFile.testStatus === "green" && floorFile.badLines === 1 && floorFile.lastEventTs === iso(T0 + 5000));
check("地板：文件不存在 → 空地板不炸", floorSummaryFromFile(path.join(telDir, "nope.jsonl")).toolCallCount === 0);

// ============ 6) 双时钟监督器 ============
let threw = null;
try { parseTimeoutValue("25mn", "timeout"); } catch (e) { threw = e; }
check("fail-load：timeout=\"25mn\"（typo）加载即报错，不许静默变无限制", threw instanceof TimeoutConfigError && threw.message.includes("25mn"));
check("fail-load：负数拒绝", (() => { try { parseTimeoutValue(-5, "timeout"); return false; } catch { return true; } })());
check("fail-load：NaN 拒绝", (() => { try { parseTimeoutValue(NaN, "idle-timeout"); return false; } catch { return true; } })());
check("解析：\"10m\"→600000 / \"90s\"→90000 / 数字→ms", parseTimeoutValue("10m", "t") === 600_000 && parseTimeoutValue("90s", "t") === 90_000 && parseTimeoutValue(3000, "t") === 3000);
check("fail-load：监督器构造即校验（typo 进构造函数也炸）", (() => { try { new DualClockSupervisor({ timeoutMs: "25mn" }); return false; } catch { return true; } })());

const warnCfg = validateSupervisorConfig({ idleTimeoutMs: 1000, slowestToolMs: 5000 });
check("校验 warning：idle 低于最慢单次工具 → 误杀警告（硬提醒落代码+校验，不机械强制）",
	warnCfg.warnings.some((w) => w.includes("高于最慢单次工具调用")) && warnCfg.warnings.some((w) => w.includes("误杀")));
check("校验 warning：设 idle 必带提醒（没给 slowestToolMs 也提醒）",
	validateSupervisorConfig({ idleTimeoutMs: "10s" }).warnings.some((w) => w.includes("静默钟设值必须高于")));

// ---- 假驱动器：零真 spawn，只记录编排器打过来的信号 ----
function makeFakeDriver() {
	const alive = new Set();
	const calls = [];
	return {
		calls,
		spawn(cfg) { calls.push({ type: "spawn", cfg }); alive.add(cfg.minionId); return cfg.minionId; },
		sendReport(id) { calls.push({ type: "report", id }); },
		sigterm(id) { calls.push({ type: "sigterm", id }); },
		sigkill(id) { calls.push({ type: "sigkill", id }); alive.delete(id); },
		isAlive(id) { return alive.has(id); },
	};
}

// 遥测时钟直接驱动监督器（假时基）：总时钟 80% → 报告模式；到点 → 三级收尾
const sup10 = new DualClockSupervisor({ timeoutMs: 10_000, graceMs: 5_000 }, () => T0);
sup10.watch("m-t", { startedAt: T0 });
const a80 = sup10.evaluate(T0 + 8_000);
check("总时钟：80% 阈值先中断转报告模式（写遗言信号）", a80.length === 1 && a80[0].type === "report_signal" && a80[0].reason === "total_timeout_warn");
check("总时钟：报告信号幂等（重复 evaluate 不重发）", sup10.evaluate(T0 + 8_500).length === 0);
const a100 = sup10.evaluate(T0 + 10_000);
check("总时钟：到点 SIGTERM", a100.length === 1 && a100[0].type === "sigterm" && a100[0].reason === "total_timeout");
const a105 = sup10.evaluate(T0 + 15_500);
check("总时钟：宽限 5s 仍活 → SIGKILL（三级收尾）", a105.length === 1 && a105[0].type === "sigkill");

// 静默钢单设（可单设）：无心跳 → idle 超限进收尾链
const supIdle = new DualClockSupervisor({ idleTimeoutMs: 5_000, graceMs: 5_000 }, () => T0);
supIdle.watch("m-s", { startedAt: T0 });
const s1 = supIdle.evaluate(T0 + 5_500);
check("静默钟：连续无输出超限 → SIGTERM（reason=idle）", s1.length === 1 && s1[0].type === "sigterm" && s1[0].reason === "idle_timeout");
check("静默钟：心跳重置（有事件不分杀）", (() => {
	const sup = new DualClockSupervisor({ idleTimeoutMs: 5_000 }, () => T0);
	sup.watch("m", { startedAt: T0 });
	sup.heartbeat("m", T0 + 4_000);
	return sup.evaluate(T0 + 5_500).length === 0 && sup.evaluate(T0 + 9_500).length === 1;
})());

// ============ 7) 失败语义：七形状全表（引擎级：台账迁移+收件箱送达类型） ============
check("失败语义表：七行全表在案", FAILURE_SEMANTICS_TABLE.length === 7
	&& ["blocked_ambiguity", "blocked_env", "known_pit", "timeout", "silent", "session_death", "second_failure"]
		.every((s) => FAILURE_SEMANTICS_TABLE.some((r) => r.shape === s)));

// 判活三源 provider：fixture 遥测（mkdtemp 目录）+ 会话原文 + 账本收据
function makeSources({ withTelemetry = true } = {}) {
	return (minionId) => {
		const src = {
			sessionText: "读 fixture 中\n正在写模块\n最后一个动作：npm test",
			receipts: [{ amount: 0.4, note: "spawn" }, { amount: 0.1, note: "心跳" }],
		};
		if (withTelemetry) src.telemetryEvents = fixtureEvents;
		return src;
	};
}

function makeEngine({ supervisorCfg = { timeoutMs: 10_000, graceMs: 5_000 }, withTelemetry = true, pits = [] } = {}) {
	const led = new SpawnLedger();
	const box = new Inbox();
	const drv = makeFakeDriver();
	const sup = supervisorCfg ? new DualClockSupervisor(supervisorCfg, () => T0) : new DualClockSupervisor({}, () => T0);
	const eng = new OrchestratorEngine({ ledger: led, inbox: box, supervisor: sup, driver: drv, sourcesFor: makeSources({ withTelemetry }), pits });
	return { eng, led, box, drv, sup };
}

// ---- 形状4：超时（永跑假分身——监督测试主链路，拆监督必红） ----
{
	const { eng, led, box, drv } = makeEngine();
	drv.spawn({ taskId: "t-timeout", minionId: "m-timeout", role: "施工分身", sheetId: "sheet-1" }); // 永跑假分身上场
	eng.start({ taskId: "t-timeout", minionId: "m-timeout", role: "施工分身", sheetId: "sheet-1", startedAt: T0 });
	eng.tick(T0 + 8_000);
	check("形状4·超时：80% 转报告模式（驱动器收写遗言信号+台账标记）",
		drv.calls.some((c) => c.type === "report" && c.id === "m-timeout") && led.get("m-timeout").reportMode === true);
	eng.tick(T0 + 10_000);
	check("形状4·超时：到点 SIGTERM", drv.calls.some((c) => c.type === "sigterm" && c.id === "m-timeout") && led.get("m-timeout").status === "跑");
	eng.tick(T0 + 15_500);
	const row = led.get("m-timeout");
	const ob = box.read();
	check("形状4·超时：5s 后 SIGKILL → 台账死+讣告送达",
		drv.calls.some((c) => c.type === "sigkill" && c.id === "m-timeout")
		&& row.status === "死" && ob.kind === "讣告" && ob.payload.cause === "超时" && ob.payload.floorSummary.testStatus === "green");
}

// ---- 形状5：静默（idle-timeout 触发） ----
{
	const { eng, led, box, drv } = makeEngine({ supervisorCfg: { idleTimeoutMs: 6_000, graceMs: 5_000 } });
	drv.spawn({ taskId: "t-silent", minionId: "m-silent", role: "施工分身", sheetId: "sheet-1" }); // 卡死假分身上场
	eng.start({ taskId: "t-silent", minionId: "m-silent", role: "施工分身", sheetId: "sheet-1", startedAt: T0 });
	// 分身卡在永不返回的工具里：起跑后再无遥测心跳
	const acts5 = [...eng.tick(T0 + 6_500), ...eng.tick(T0 + 11_500)];
	const row = led.get("m-silent");
	const ob = box.read();
	check("形状5·静默：idle 超限 → 三级收尾 → 台账死+讣告（死因明细写静默钟）",
		acts5.some((a) => a.type === "sigterm" && a.reason === "idle_timeout") && acts5.some((a) => a.type === "sigkill")
		&& row.status === "死" && ob.kind === "讣告" && ob.payload.causeDetail.includes("idle-timeout"));
}

// ---- 突变对照：拆掉双时钟监督（不监督配置）→ 永跑假分身无人收 ----
{
	const { eng, led, box, drv } = makeEngine({ supervisorCfg: null }); // 注入「不监督」
	eng.start({ taskId: "t-forever", minionId: "m-forever", role: "施工分身", sheetId: "sheet-1", startedAt: T0 });
	for (const t of [T0 + 10_000, T0 + 60_000, T0 + 3_600_000]) eng.tick(t);
	check("突变对照：无监督配置 → 永跑分身不被杀（监督组测试红的原因即在此——正常配置必须杀得动）",
		drv.calls.every((c) => c.type !== "sigkill" && c.type !== "sigterm") && led.get("m-forever").status === "跑" && box.size() === 0);
}

// ---- 形状1：BLOCKED·任务书歧义 → 停手转前台改书 ----
{
	const { eng, led, box, drv } = makeEngine();
	eng.start({ taskId: "t-amb", minionId: "m-amb", role: "施工分身", sheetId: "sheet-1", startedAt: T0 });
	eng.reportBlocked("m-amb", { kind: "ambiguity", detail: "「只动 X」与交付物 Y 冲突，分身不当裁判" });
	const ob = box.read();
	check("形状1·歧义：台账转等审+收件箱送达通知（转前台改书）",
		led.get("m-amb").status === "等审" && ob.kind === "通知" && ob.payload.reason.includes("转前台改书") && drv.calls.some((c) => c.type === "sigterm"));
}

// ---- 形状2：BLOCKED·环境缺 → fail-fast 讣告写明缺什么 ----
{
	const { eng, led, box } = makeEngine();
	eng.start({ taskId: "t-env", minionId: "m-env", role: "施工分身", sheetId: "sheet-1", startedAt: T0 });
	eng.reportBlocked("m-env", { kind: "env", detail: "OPENAI_API_KEY 未配置" });
	const ob = box.read();
	check("形状2·环境缺：fail-fast 台账死+讣告写明缺什么",
		led.get("m-env").status === "死" && ob.kind === "讣告" && ob.payload.cause === "环境" && ob.payload.causeDetail.includes("OPENAI_API_KEY"));
}

// ---- 形状3：BLOCKED·已知坑形状 → 自动重试≤1 + workaround 注入；二次命中 → 形状7 ----
{
	const pits = [{
		id: "pit-eaddrinuse",
		match: (ev) => ev?.kind === "tool_use" && ev?.data?.tool === "bash" && /EADDRINUSE/.test(String(ev?.data?.input?.command ?? "")),
		workaround: "换随机端口重试（port 0）",
	}];
	const { eng, led, box, drv } = makeEngine({ pits, supervisorCfg: { timeoutMs: 60_000 } });
	eng.start({ taskId: "t-pit", minionId: "m-pit", role: "施工分身", sheetId: "sheet-1", startedAt: T0 });
	const pitEv = { v: 1, ts: iso(T0 + 1000), kind: "tool_use", data: { tool: "bash", input: { command: "node server.js  # EADDRINUSE" }, isError: true } };
	const res = eng.telemetryEvent("m-pit", pitEv);
	const spawnCall = drv.calls.find((c) => c.type === "spawn");
	check("形状3·已知坑：重试1次+workaround注入+失败原因作重试输入",
		res.retried === true && spawnCall.cfg.workaround === "换随机端口重试（port 0）" && spawnCall.cfg.failureReason === "known_pit:pit-eaddrinuse"
		&& led.get("m-pit").status === "死" && led.get("m-pit-retry1").status === "跑");
	// 重试分身再撞同一坑 → 二败升级叫醒主agent（形状7）
	const res2 = eng.telemetryEvent("m-pit-retry1", { ...pitEv, ts: iso(T0 + 2000) });
	const ob = box.read();
	check("形状7·二败（坑形状二次命中）：停止自动处理+讣告升级叫醒主agent",
		res2.escalated === true && ob.kind === "讣告" && ob.payload.escalated === true && ob.payload.wakeMainAgent === true
		&& eng.tasks.get("t-pit").stopped === true && led.get("m-pit-retry1").status === "死");
}

// ---- 形状7（另一路）：同任务第二次失败（环境缺两连） → 升级 ----
{
	const { eng, led, box } = makeEngine();
	eng.start({ taskId: "t-2nd", minionId: "m-2a", role: "施工分身", sheetId: "sheet-1", startedAt: T0 });
	eng.reportBlocked("m-2a", { kind: "env", detail: "缺 KEY" });
	const first = box.read();
	eng.start({ taskId: "t-2nd", minionId: "m-2b", role: "施工分身", sheetId: "sheet-1", startedAt: T0 + 1_000 });
	eng.reportBlocked("m-2b", { kind: "env", detail: "缺 KEY" });
	const second = box.read();
	check("形状7·二败：首败普通讣告，二败升级叫醒主agent+停止自动处理",
		first.payload.escalated !== true && second.kind === "讣告" && second.payload.escalated === true
		&& second.payload.wakeMainAgent === true && eng.tasks.get("t-2nd").stopped === true && led.get("m-2b").status === "死");
}

// ---- 形状6：session 死亡（非硬停）→ 讣告走判活三源 ----
{
	const { eng, led, box } = makeEngine();
	eng.start({ taskId: "t-sd", minionId: "m-sd", role: "施工分身", sheetId: "sheet-1", startedAt: T0 });
	eng.telemetryEvent("m-sd", { v: 1, ts: iso(T0 + 500), kind: "tool_use", data: { tool: "write", input: { path: "/repo/src/x.mjs" }, isError: false } });
	eng.reportSessionDeath("m-sd", { detail: "进程无+心跳断（非硬停）" });
	const ob = box.read();
	check("形状6·session死亡：台账死+讣告死因自杀+三源salvage（文件/测试/会话尾）",
		led.get("m-sd").status === "死" && ob.kind === "讣告" && ob.payload.cause === "自杀"
		&& ob.payload.salvage.filesTouched.length > 0 && ob.payload.salvage.sessionTail.includes("npm test"));
}

// ---- 交货单（正向闭环） ----
{
	const { eng, led, box } = makeEngine();
	eng.start({ taskId: "t-ok", minionId: "m-ok", role: "施工分身", sheetId: "sheet-1", startedAt: T0 });
	eng.deliver("m-ok", { files: ["src/orchestrator/index.mjs"], tests: "green" });
	const ob = box.read();
	check("交货：台账收+交货单送达", led.get("m-ok").status === "收" && ob.kind === "交货单" && ob.payload.manifest.tests === "green");
}

// ---- 突变对照：拆掉心跳登记（registerHeartbeat 不更新台账） → 心跳测试必红 ----
{
	const led2 = new SpawnLedger();
	led2.register({ id: "m-hb", role: "施工分身", sheetId: "s", startedAt: T0 });
	const before = led2.get("m-hb").lastHeartbeat;
	// 正常路径：编排器收遥测即登记（引擎里就是这么接的）
	const { eng } = makeEngine();
	eng.start({ taskId: "t-hb", minionId: "m-hb2", role: "施工分身", sheetId: "sheet-1", startedAt: T0 });
	eng.telemetryEvent("m-hb2", { v: 1, ts: iso(T0 + 3_000), kind: "tool_use", data: { tool: "bash", input: { command: "ls" }, isError: false } });
	check("突变对照·心跳：遥测进编排器 → 台账最后心跳+最后工具登记（拆 registerHeartbeat 此测必红）",
		before === null && eng.ledger.get("m-hb2").lastHeartbeat === iso(T0 + 3_000) && eng.ledger.get("m-hb2").lastTool === "bash");
}

// ============ 8) 讣告：缺源降级出声，不装全知 ============
{
	const minion = { id: "m-x", role: "施工分身", sheetId: "sheet-1", startedAt: T0, cost: 0.5 };
	const full = generateObituary({ minion, cause: "自杀", detail: "进程无", sources: makeSources()("m-x") });
	check("讣告：三源齐 → 完整讣告无降级", full.degraded === false && full.missingSources.length === 0 && full.floorSummary != null && full.costBasis === "账本收据合计");
	const blind = generateObituary({ minion, cause: "自杀", detail: "进程无", sources: { sessionText: "只写了半句", receipts: [] } });
	check("讣告·阴性对照：拆掉遥测源 → 必标「遥测源缺失」，不出地板不装全知",
		blind.degraded === true && blind.missingSources.includes("遥测源")
		&& blind.floorSummary === null && blind.salvage.filesTouched.length === 0 && blind.salvage.notes.some((n) => n.includes("遥测源缺失")));
	const blind2 = generateObituary({ minion, cause: "超时", detail: "x", sources: { telemetryEvents: [] } });
	check("讣告：缺会话原文+账本 → 逐个点名", blind2.missingSources.includes("会话原文源") && blind2.missingSources.includes("账本收据源") && blind2.costBasis.includes("台账行自记"));
	check("讣告：非法死因拒绝", (() => { try { generateObituary({ minion, cause: "累死", sources: {} }); return false; } catch { return true; } })());
	check("讣告：三死因下一步建议各就位", ["超时", "环境", "自杀"].every((c) => generateObituary({ minion, cause: c, sources: {} }).nextStep.length > 0));
}

// ---- 收尾 ----
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
