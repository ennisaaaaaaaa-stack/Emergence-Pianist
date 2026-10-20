// t16-fix 活2：retro-trigger 源3 fire 侧接线测试（gap H2——createSessionEndHook 注册位在、
// evaluateRetroTrigger hookFired 参数位在，此前全仓零 fire 方）。
// 接线形状：runtime.mjs completionPump 分身退场统一路径（DONE/阻塞/死都算收尾）调
// sessionEndHook.fire(...)——事件 {minionId, taskId, role, outcome, exitCode, signal}。
// 断言面（任务书验收逐条）：
//   - stub 分身退场 → 源3事件出：done / blocked / verdict / death 四结局各就各位（字段对齐台账行）；
//   - 源3事件进判定流：事件在场 → evaluateRetroTrigger({hookFired:true,...}) → fire reason=hook；
//   - 阴性对照：sessionEndHook:false（拔线位）→ 钩子对象 null，退场零源3事件（结构上无从 fire）；
//   - 零注册方 fire 不炸不挡路：retropad 自用 buildRuntime（零 handler）照常收尾——不递归的根据。
// 突变敏感（复验者亲手掰）：
//   - completionPump 里的 fire 调用置空 → 四结局断言全红（事件数组空）；
//   - outcome 分类拆掉 → 四结局各自断言红（done 被报成 death 之类）；
//   - 拔线位默认值翻成 false → 正向组全红（sessionEndHook null）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---- 夹具隔离（纪律）：凭证/进度/遥测/会话目录全指 tmp，不写生产路径；壳地址指死端口 ----
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "retro-hook-wire-"));
const credDir = path.join(tmpRoot, "cred");
const journalFile = path.join(tmpRoot, "journal.jsonl");
const progressDir = path.join(tmpRoot, "progress");
const telemetryDir = path.join(tmpRoot, "telemetry");
const sessionsDir = path.join(tmpRoot, "sessions");
for (const d of [credDir, progressDir, telemetryDir, sessionsDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(credDir, "coding-plan"), "retro-hook-wire-key-never-printed");
process.env.PORTALK_CRED_DIR = credDir;
process.env.PORTALK_CRED_JOURNAL = journalFile;
process.env.ORCH_PROGRESS_DIR = progressDir;
process.env.PIANIST_TELEMETRY_DIR = telemetryDir;
process.env.PIANIST_SESSIONS_DIR = sessionsDir;
process.env.PIANIST_SHELL_URL = "http://127.0.0.1:1";
delete process.env.ZAI_CODING_CN_API_KEY;

let pass = 0, total = 0;
function check(name, ok, extra) {
	total++;
	if (ok) pass++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra !== undefined && !ok ? " — " + extra : ""}`);
}

// ---- stub pi（零真钱）：四结局 + 挂死，env 驱动 ----
const stubPath = path.join(tmpRoot, "stub-pi.mjs");
fs.writeFileSync(stubPath, `const mode = process.env.HOOK_STUB_MODE ?? "done";
if (mode === "done") { console.log("工作完成"); console.log("DONE"); process.exit(0); }
if (mode === "blocked") { console.log("BLOCKED:环境: 缺钥匙（stub）"); process.exit(0); }
if (mode === "verdict") { console.log("机械核对三件全过"); console.log("VERDICT:pass"); process.exit(0); }
if (mode === "crash") { console.log("半路炸了（无协议行）"); process.exit(1); }
setInterval(() => {}, 1073741824); // hang：等信号收
`);
process.env.ORCH_PI_BIN = stubPath;

const { buildRuntime } = await import("../src/orchestrator/runtime.mjs");
const { evaluateRetroTrigger, DEFAULT_HOTSPOT_THRESHOLD } = await import("../src/orchestrator/retro-trigger.mjs");

const sheetTextOf = () => `# 源3接线夹具书
背景与边界：夹具，零真钱——只测收尾钩子 fire 侧
预算袋：时长 30 分钟
角色表：
  - 角色:施工分身 | 数量:1 | 沙箱:无
交付物清单：
  - 无
验收标准：
  - 退场即源3事件
纪律：
  - 不 commit 留工作区`;

const allRuntimes = [];
function makeRuntime(opts = {}) {
	const rt = buildRuntime({ sheetText: sheetTextOf(), piBin: stubPath, ...opts });
	allRuntimes.push(rt);
	return rt;
}

/** 发车一个 stub 分身，等退场，返回（钩子事件快照, 台账行） */
async function runOne(mode, opts = {}) {
	process.env.HOOK_STUB_MODE = mode; // stub 经 env 驱动（driver spawn 透传 process.env）
	const rt = makeRuntime(opts);
	const events = [];
	rt.sessionEndHook?.register((ev) => events.push(ev));
	const rec = rt.launchMinion({ taskId: `t-${mode}`, role: "施工分身" });
	await rt.driver.rows.get(rec.minionId).closed;
	return { events, rt, minionId: rec.minionId, taskId: `t-${mode}` };
}

// ============ 1) DONE 退场 → outcome=done 事件 + 进判定流 reason=hook ============
{
	const { events, minionId, taskId } = await runOne("done");
	check("done：退场恰出一枚源3事件", events.length === 1, JSON.stringify(events));
	const ev = events[0] ?? {};
	check("done：事件字段对齐台账行（minionId/taskId/role/outcome/exitCode/signal）",
		ev.minionId === minionId && ev.taskId === taskId && ev.role === "施工分身"
		&& ev.outcome === "done" && ev.exitCode === 0 && ev.signal == null,
		JSON.stringify(ev));
	// 源3事件进判定流：热点低于阈 + 未到期，唯有钩子能拉——reason=hook 即判定流消费形状
	const trig = evaluateRetroTrigger({
		report: { v: 1, hotspots: [{ lastTs: new Date().toISOString() }], errorHotspots: [] },
		threshold: DEFAULT_HOTSPOT_THRESHOLD,
		lastRetroAt: Date.now() - 60_000, // 1 分钟前刚盘完：未到期
		intervalMs: 6 * 60 * 60 * 1000,
		hookFired: events.length > 0 && ev.outcome != null, // 事件在场才喂 hookFired——接线断则 false
	});
	check("done：源3事件进判定流 → evaluateRetroTrigger fire reason=hook",
		trig.fire === true && trig.reason === "hook", JSON.stringify(trig));
}

// ============ 2) BLOCKED 退场 → outcome=blocked ============
{
	const { events } = await runOne("blocked");
	check("blocked：退场 → outcome=blocked（阻塞也算收尾）",
		events.length === 1 && events[0].outcome === "blocked" && events[0].exitCode === 0,
		JSON.stringify(events));
}

// ============ 3) VERDICT 退场 → outcome=verdict ============
{
	const { events } = await runOne("verdict");
	check("verdict：退场 → outcome=verdict（审链裁决也算收尾）",
		events.length === 1 && events[0].outcome === "verdict",
		JSON.stringify(events));
}

// ============ 4) 暴死退场（code 1 无协议）→ outcome=death ============
{
	const { events } = await runOne("crash");
	check("death：非零退场无协议 → outcome=death（死也算收尾）",
		events.length === 1 && events[0].outcome === "death" && events[0].exitCode === 1,
		JSON.stringify(events));
}

// ============ 5) 阴性对照：拔线位（sessionEndHook:false）→ 零源3事件 ============
{
	process.env.HOOK_STUB_MODE = "done";
	const rt = makeRuntime({ sessionEndHook: false });
	check("阴性·拔线：sessionEndHook:false → 钩子对象 null（退场零源3事件——结构上无从 fire）",
		rt.sessionEndHook === null || rt.sessionEndHook === undefined);
	const rec = rt.launchMinion({ taskId: "t-offline", role: "施工分身" });
	await rt.driver.rows.get(rec.minionId).closed;
	check("阴性·拔线：退场照常收尾（交货单进收件箱，泵没被拔线拖死）",
		rt.inbox.items.some((i) => i.payload?.minionId === rec.minionId && i.kind === "交货单"),
		JSON.stringify(rt.inbox.items.map((i) => i.kind)));
}

// ============ 6) 零注册方 fire 不炸（retropad 自用 buildRuntime 不递归的根据） ============
{
	process.env.HOOK_STUB_MODE = "done";
	const rt = makeRuntime(); // 零 handler 注册
	const rec = rt.launchMinion({ taskId: "t-nohandler", role: "施工分身" });
	await rt.driver.rows.get(rec.minionId).closed;
	check("零注册方：fire 是 no-op 不炸（交货链照走）",
		rt.inbox.items.some((i) => i.payload?.minionId === rec.minionId) === true);
}

// ============ 7) 钩子处理器抛错不炸调用方（retro-trigger 原契约保持） ============
{
	process.env.HOOK_STUB_MODE = "done";
	const rt = makeRuntime();
	rt.sessionEndHook.register(() => { throw new Error("处理器炸了（预期）"); });
	const rec = rt.launchMinion({ taskId: "t-throw", role: "施工分身" });
	let closed = false;
	try { await rt.driver.rows.get(rec.minionId).closed; closed = true; } catch {}
	check("处理器抛错：泵照常收尾（单处理器炸不挡交货链）",
		closed && rt.inbox.items.some((i) => i.payload?.minionId === rec.minionId));
}

for (const rt of allRuntimes) rt.stop();
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
