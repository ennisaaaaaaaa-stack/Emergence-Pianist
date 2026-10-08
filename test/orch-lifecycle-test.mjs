// 施工⑧ 第二铲：生命周期看门 + 常驻 tick 测试（watchman 三判/幂等/阴性对照 × startLoop/stop）。
// 纪律：零真钱——ORCH_PI_BIN 全程指 node stub（hang/done 两态），沙箱不经 executor，夹具全指 mkdtemp tmp
//       （凭证/进度/遥测/会话），不写生产路径；不挂真 pi（live 端到端在 orch-e2e-live.mjs，单跑花钱）。
// 阴性对照（灵魂——the author复验阶段亲手掰，测试里以断言结构钉住）：
//   - 看门人三判拆掉任一判（心跳活着/进程活着/状态不在跑）→ 该喊的断言必红；
//   - 幂等拆掉（喊过不记名）→ 「只喊一次」断言必红；
//   - startLoop 的 interval 拆掉 → 假时钟推进监督断言必红；stop() 拆掉 clearInterval → 子进程自然退断言必红。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra !== undefined && !ok ? " — " + extra : ""}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
	return false;
}

// ---- 夹具隔离（纪律，与第一铲同款）：PORTALK_CRED_DIR/JOURNAL + ORCH_PROGRESS_DIR + 遥测/会话目录全指 tmp ----
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "orch-lifecycle-"));
const credDir = path.join(tmpRoot, "cred");
const journalFile = path.join(tmpRoot, "journal.jsonl");
const progressDir = path.join(tmpRoot, "progress");
const telemetryDir = path.join(tmpRoot, "telemetry");
const sessionsDir = path.join(tmpRoot, "sessions");
for (const d of [credDir, progressDir, telemetryDir, sessionsDir]) fs.mkdirSync(d, { recursive: true });
const V_FIXTURE = "orch-lifecycle-key-never-printed";
fs.writeFileSync(path.join(credDir, "coding-plan"), V_FIXTURE);
process.env.PORTALK_CRED_DIR = credDir;
process.env.PORTALK_CRED_JOURNAL = journalFile;
process.env.ORCH_PROGRESS_DIR = progressDir;
process.env.PIANIST_TELEMETRY_DIR = telemetryDir;
process.env.PIANIST_SESSIONS_DIR = sessionsDir;
delete process.env.ZAI_CODING_CN_API_KEY;
delete process.env.PIANIST_SHELL_URL;

// ---- stub pi（零真钱）：done=写 DONE 退场；hang=挂死不写（等外部信号收尸——runtime 接线段用） ----
const stubPath = path.join(tmpRoot, "stub-pi.mjs");
fs.writeFileSync(stubPath, `const mode = process.env.ORCH_STUB_MODE ?? "hang";
if (mode === "done") { console.log("工作完成"); console.log("DONE"); process.exit(0); }
setInterval(() => {}, 1073741824); // hang：挂死不写
`);
process.env.ORCH_PI_BIN = stubPath;

const { SpawnLedger } = await import("../src/orchestrator/ledger.mjs");
const { Inbox } = await import("../src/orchestrator/inbox.mjs");
const { Watchman } = await import("../src/orchestrator/watchman.mjs");
const { buildRuntime } = await import("../src/orchestrator/runtime.mjs");

const allRuntimes = []; // 收尾兜底：收尸一切在场 stub
function makeRuntime(sheetText, opts = {}) {
	const rt = buildRuntime({ sheetText, piBin: stubPath, ...opts });
	allRuntimes.push(rt);
	return rt;
}
const sheetTextOf = () => `# 生命周期夹具书
背景与边界：夹具，零真钱
预算袋：时长 30 分钟
角色表：
  - 角色:施工分身 | 数量:1 | 沙箱:无
交付物清单：
  - 无
验收标准：
  - 看门与常驻 tick 各归各的账
纪律：
  - 不 commit 留工作区`;

// ============ 1) 看门该喊：三判全中 → 收件箱讣告候选（kind 对、指针对、不内联现场） ============
{
	const T = 1_750_000_000_000;
	const ledger = new SpawnLedger();
	const inbox = new Inbox();
	const dead = new Set(["m-dead"]); // 假驱动器：dead 集合内 isAlive=false，其余 true
	const fakeDriver = { isAlive: (id) => !dead.has(id) };
	ledger.register({ id: "m-dead", role: "施工分身", sheetId: "sheet-x", startedAt: T - 20 * 60_000 });
	ledger.registerHeartbeat("m-dead", { ts: new Date(T - 10 * 60_000).toISOString(), kind: "tool_use", tool: "bash" });
	ledger.setStatus("m-dead", "跑", "内联禁区哨兵-XYZZY"); // note 是现场——讣告候选不该把它内联进去
	const wm = new Watchman({ ledger, inbox, driver: fakeDriver, now: () => T, silentWindowMs: 60_000 });
	const shouted = wm.sweep();
	const item = inbox.peek();
	check("该喊：三判全中（跑×静默10min×进程无）→ 收件箱出现讣告候选",
		shouted.length === 1 && item?.kind === "通知" && item.payload.kind === "讣告候选" && item.payload.minionId === "m-dead",
		JSON.stringify(shouted.length) + " " + JSON.stringify(item?.payload));
	check("该喊：台账行指针对（minionId/sheetId/状态），不内联台账行全文（哨兵 note 不进收件箱）",
		item.payload.ledgerPointer?.minionId === "m-dead" && item.payload.ledgerPointer?.sheetId === "sheet-x"
		&& item.payload.ledgerPointer?.status === "跑" && !JSON.stringify(inbox.items).includes("XYZZY"));
	check("该喊：附最后心跳时刻+静默时长（验尸线索，法医按失败语义表裁 session_death）",
		item.payload.lastHeartbeat === new Date(T - 10 * 60_000).toISOString() && item.payload.silentMs === 10 * 60_000);
	check("该喊：看门不入账不定死（台账行原样=跑，收件箱无讣告只有通知）",
		ledger.get("m-dead").status === "跑" && inbox.items.every((i) => i.kind !== "讣告"));
	// 窗沿：静默恰等于窗 → 喊（≥ 窗即超窗）；差 1ms 不喊
	ledger.register({ id: "m-edge", role: "施工分身", sheetId: "sheet-x", startedAt: T - 60_000 }); // 无心跳：从发车起算静默
	dead.add("m-edge");
	const sh2 = wm.sweep();
	check("窗沿：静默==静默窗 → 喊（≥ 即超窗）；从没跳过的心脏按发车时刻起算",
		sh2.length === 1 && sh2[0].minionId === "m-edge" && inbox.peekAll().filter((i) => i.payload.kind === "讣告候选").length === 2);
}

// ============ 2) 看门不该喊（阴性对照灵魂）：心跳活着不喊 / 进程活着不喊 / 状态不在跑不喊 ============
{
	const T = 1_750_000_000_000;
	const ledger = new SpawnLedger();
	const inbox = new Inbox();
	const dead = new Set();
	const fakeDriver = { isAlive: (id) => !dead.has(id) };
	// a) 心跳活着（静默窗内）+ 进程不在 → 不喊（刚退场，收尾泵在路上——不是「死透了」）
	ledger.register({ id: "m-fresh", role: "施工分身", sheetId: "s", startedAt: T - 120_000 });
	ledger.registerHeartbeat("m-fresh", { ts: new Date(T - 10_000).toISOString() });
	dead.add("m-fresh");
	// b) 进程活着 + 心跳停 15min（超窗）→ 不喊（还在干活不算死，静默钟才是它的医生）
	ledger.register({ id: "m-alive", role: "施工分身", sheetId: "s", startedAt: T - 20 * 60_000 });
	ledger.registerHeartbeat("m-alive", { ts: new Date(T - 15 * 60_000).toISOString() });
	// c) 静默+死透但状态=收（已下场）→ 不喊（三判①不在跑）
	ledger.register({ id: "m-done", role: "施工分身", sheetId: "s", startedAt: T - 20 * 60_000 });
	ledger.registerHeartbeat("m-done", { ts: new Date(T - 15 * 60_000).toISOString() });
	ledger.setStatus("m-done", "收");
	dead.add("m-done");
	const wm = new Watchman({ ledger, inbox, driver: fakeDriver, now: () => T, silentWindowMs: 60_000 });
	const shouted = wm.sweep();
	check("不该喊·阴性a：心跳活着（窗内）+进程无 → 无讣告候选（刚退场不算死透）", shouted.length === 0 && inbox.size() === 0,
		JSON.stringify(shouted));
	check("不该喊·阴性b：进程活着+心跳停超窗 → 无讣告候选（卡慢工具不是死，那是静默钟的活）",
		!wm.shoutedFor("m-alive") && inbox.size() === 0);
	check("不该喊·阴性c：状态=收（死透也下场了）→ 无讣告候选（三判①状态=跑才喊）",
		!wm.shoutedFor("m-done") && inbox.size() === 0);
}

// ============ 3) 看门幂等：连续 sweep 同一死分身 → 收件箱只一条 ============
{
	const T = 1_750_000_000_000;
	const ledger = new SpawnLedger();
	const inbox = new Inbox();
	const fakeDriver = { isAlive: () => false };
	ledger.register({ id: "m-once", role: "施工分身", sheetId: "s", startedAt: T - 30 * 60_000 });
	const wm = new Watchman({ ledger, inbox, driver: fakeDriver, now: () => T, silentWindowMs: 60_000 });
	const rounds = [wm.sweep(), wm.sweep(), wm.sweep(T + 60_000), wm.sweep(T + 120_000)]; // 时钟照走，尸体不动
	const candidates = inbox.peekAll().filter((i) => i.payload.kind === "讣告候选" && i.payload.minionId === "m-once");
	check("幂等：连续 4 轮 sweep 同一死分身 → 收件箱只一条（喊过记名不二喊）",
		rounds[0].length === 1 && rounds[1].length === 0 && rounds[2].length === 0 && rounds[3].length === 0
		&& candidates.length === 1 && wm.shoutedFor("m-once"));
}

// ============ 4) runtime 看门接线：真 stub 进程被外部 SIGKILL（台账留「跑」的孤儿形状）→ sweep 喊 ============
{
	process.env.ORCH_STUB_MODE = "hang";
	process.env.ORCH_STUB_TELEMETRY = "";
	const rt = makeRuntime(sheetTextOf(), { supervisorCfg: { timeoutMs: 600_000 }, watchmanSilentMs: 1_200 });
	check("接线：runtime 默认带看门（watchman 在场、可 sweep）", rt.watchman != null && typeof rt.sweep === "function");
	const rec = rt.launchMinion({ taskId: "t-wm", role: "施工分身", minionId: "m-wm" });
	await sleep(250); // 等进程真起来（isAlive 从 pid 探活，起不来前 ESRCH 会假死——只许活进程不喊）
	check("接线·阴性：进程活着 → sweep 不喊（哪怕无心跳静默）", rt.sweep().length === 0 && rt.inbox.size() === 0,
		JSON.stringify(rt.sweep()));
	process.kill(rec.pid, "SIGKILL"); // 外部横死：close 带 signal → 收尾泵不抢（信号死归引擎），台账留「跑」——看门的靶子形状
	await rt.driver.rows.get("m-wm").closed;
	check("接线：外部 SIGKILL 后台账留「跑」（收尾泵不抢信号死——这正是看门要报的孤儿形状）",
		rt.ledger.get("m-wm").status === "跑" && rt.driver.rows.get("m-wm").exit?.signal === "SIGKILL");
	check("接线·阴性：死透但静默未超窗（发车<1.2s）→ 不喊", rt.sweep().length === 0);
	const okShout = await waitFor(() => rt.sweep().length > 0, 3_000); // 真时钟走到静默窗满
	const item = rt.inbox.items.find((i) => i.payload.kind === "讣告候选");
	check("接线：静默窗满+进程无 → runtime 级 sweep 喊出讣告候选（指针对）",
		okShout && item?.payload.minionId === "m-wm" && item.payload.ledgerPointer?.status === "跑" && item.kind === "通知");
	rt.sweep(); rt.sweep();
	check("接线·幂等：runtime 级重复 sweep → 仍只一条", rt.inbox.items.filter((i) => i.payload.kind === "讣告候选").length === 1);
	// 开关位：watchman:false → 不接线（阴性对照/测试位）
	const rtOff = makeRuntime(sheetTextOf(), { supervisorCfg: { timeoutMs: 600_000 }, watchman: false });
	check("接线：watchman:false 开关生效（不接线，sweep 空手）", rtOff.watchman === null && rtOff.sweep().length === 0);
}

// ============ 5) startLoop 假时钟推进（验收5，复用第一铲监督断言形状）：挂上即转、时钟走钟响、stop 停转 ============
{
	const T0 = 1_700_000_000_000;
	let clock = T0;
	process.env.ORCH_STUB_MODE = "hang";
	const rt = makeRuntime(sheetTextOf(), { supervisorCfg: { timeoutMs: 10_000, graceMs: 5_000 }, now: () => clock, watchmanSilentMs: 60_000 });
	rt.launchMinion({ taskId: "t-loop", role: "施工分身", minionId: "m-loop" });
	rt.startLoop(15); // 常驻 tick 15ms（真 interval，假时钟由注入 now 读出）
	await sleep(100); // ~6 轮 fire，时钟不动 → 什么都不该发生
	check("startLoop：挂上即转（时钟不动 → 无监督动作：台账跑、无遗言、无讣告）",
		rt.ledger.get("m-loop").status === "跑" && !fs.existsSync(path.join(progressDir, "m-loop.md")) && rt.inbox.size() === 0);
	clock = T0 + 8_500; // 80%：转报告模式
	await sleep(100);
	check("startLoop：假时钟推进到 80% → 转报告模式（遗言文件+reportMode=true——第一铲监督断言形状）",
		fs.existsSync(path.join(progressDir, "m-loop.md")) && rt.ledger.get("m-loop").reportMode === true);
	clock = T0 + 10_000; // 到点：SIGTERM 三级收尾
	const dead = await waitFor(() => rt.ledger.get("m-loop").status === "死", 5_000);
	check("startLoop：假时钟推进到点 → 三级收尾（真 SIGTERM 杀挂死 stub→台账死+超时讣告）",
		dead && rt.driver.rows.get("m-loop").exit?.signal === "SIGTERM"
		&& rt.inbox.items.some((i) => i.kind === "讣告" && i.payload.cause === "超时"));
	rt.stop(); // 停转（拍板#5 stop）
	check("stop()：interval 清（loopRunning=false）+ watcher 停", rt.loopRunning() === false);
	// 停转阴性：stop 后再发车+时钟推到天荒地老 → 不再有任何监督动作（interval 残留则此断言红）
	clock = T0 + 2_000;
	rt.launchMinion({ taskId: "t-loop", role: "施工分身", minionId: "m-loop2" });
	const inboxBefore = rt.inbox.items.length;
	clock = T0 + 999_999_999; // 远超总时钟
	await sleep(150);
	check("stop()·阴性：停转后时钟推进不再触发监督（m-loop2 仍跑、收件箱无新事件）",
		rt.ledger.get("m-loop2").status === "跑" && rt.inbox.items.length === inboxBefore
		&& !fs.existsSync(path.join(progressDir, "m-loop2.md")));
}

// ============ 6) stop 后进程自然退（interval 残留会挂住事件循环——子进程真实验证，零真钱） ============
{
	const script = path.join(tmpRoot, "looper.mjs");
	const runtimeHref = new URL("../src/orchestrator/runtime.mjs", import.meta.url).href;
	fs.writeFileSync(script, `import { buildRuntime } from ${JSON.stringify(runtimeHref)};
const rt = buildRuntime({ sheetText: ${JSON.stringify(sheetTextOf())}, piBin: ${JSON.stringify(stubPath)},
	supervisorCfg: { timeoutMs: 600_000 }, progressDir: ${JSON.stringify(progressDir)},
	telemetryDir: ${JSON.stringify(telemetryDir)}, sessionsDir: ${JSON.stringify(sessionsDir)} });
rt.startLoop(10);
setTimeout(() => rt.stop(), 80); // stop 后无句柄持住事件循环 → 进程应自然退（本脚本无 process.exit）
`);
	const child = spawn(process.execPath, [script], { stdio: ["ignore", "pipe", "pipe"] });
	let errText = "";
	child.stderr.on("data", (d) => { errText += d.toString(); });
	const code = await Promise.race([
		new Promise((resolve) => child.on("close", (c) => resolve(c))),
		sleep(5_000).then(() => { child.kill("SIGKILL"); return "TIMEOUT"; }),
	]);
	check("自然退：startLoop→stop 后子进程自然退出（interval 清了才退得掉，残留则 TIMEOUT 红）",
		code === 0, `exit=${code} stderr=${errText.slice(0, 200)}`);
}

// ============ 7) 零真钱：全程真 pi 拉起数=0 ============
{
	let spawned = 0, stubs = 0;
	for (const rt of allRuntimes) {
		for (const [id, rec] of rt.driver.rows) {
			spawned++;
			if (rec.entry === stubPath) stubs++;
		}
	}
	check(`零真钱：全部 ${spawned} 次 spawn 的入口都是 stub（真 pi bundle 拉起数=0；live 端到端在 orch-e2e-live.mjs 单跑）`,
		spawned > 0 && spawned === stubs);
}

// ---- 收尾兜底：收尸一切在场 stub（不许测试进程留下孤儿子进程）；tmp 夹具回收 ----
for (const rt of allRuntimes) {
	rt.stop();
	for (const [id, rec] of rt.driver.rows) {
		if (!rec.done && Number.isInteger(rec.pid)) { try { process.kill(rec.pid, "SIGKILL"); } catch { /* 已死 */ } }
	}
}
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
