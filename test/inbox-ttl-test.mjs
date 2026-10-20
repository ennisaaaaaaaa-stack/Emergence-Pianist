// F2 收件箱按天清测试（spec：docs/f2-inbox-ttl-spec-v0.2.1.md 验收 1-7 全条映射）。
// 覆盖：
//   验收1 runtime inbox：day=yesterday 交货单 → 首 tick（startLoop 真钩子）后消失 + 清理记账行含 seq
//   验收2 壳审批卡：day=yesterday → pending 查不到 + 终态查询 denied(by=system-expired) 决断行不是空
//          （单元面 + 真壳 HTTP 面；消费面 3a：壳 /approvals/pending 与 runtime pollApprovals 都不透 denied）
//   验收3 day=today 原封不动（阴性对照，两对象）
//   验收4 清理零 spawn/relaunch（函数体提取 grep 机器自证）+ conductor --once 清理前后 state.watchman 零 diff
//   验收5 env 三型（day/24h/tiered）各跑一遍清理判定 + 非法值 conductor 常驻面 fail-fast（exit 1 + 出声）
//   验收6 假钟跨界：同一注入钟写入与清判一致——23:59:59.999 写入即扫不清、+1ms 日界翻篇即清（无死区）
//   验收7 存量卡补打（施工读法 A 钉）：无 day 旧卡在 day 模式永不清（B 读法反面证据）→ 迁移补打
//          day=部署日（真钟）→ 当日不清 → 次日被清 + 记账行含 id；工具 spawnSync 直跑（mock 壳：
//          dry-run 零写 / 真跑补打 / 死端口 fail-fast）
// 纪律：剥净 CONDUCTOR_*/ORCH_* ambient、死端口隔离（PIANIST_SHELL_URL=http://127.0.0.1:1）、
//   凭证隔离（PORTALK_CRED_DIR 指 mkdtemp）；真壳随机端口 + tmp 审计文件，绝不碰 8770 真壳；
//   迁移脚本 spawnSync 直跑（黑盒），不 import 脚本内部；mock 壳独立进程（spawnSync 阻塞父循环，同进程 server 应不了答——实测坑）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra !== undefined && !ok ? " — " + extra : ""}`); }
process.on("exit", (code) => { if (pass !== total) console.error(`[inbox-ttl-test] exit=${code}——${pass}/${total}（未过面即非零退）`); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 密封底（同 emit-test 方子）----
const credTmp = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-ttl-cred-"));
process.env.PORTALK_CRED_DIR = path.join(credTmp, "cred");
process.env.PORTALK_CRED_JOURNAL = path.join(credTmp, "journal.jsonl");
process.env.PIANIST_SHELL_URL = "http://127.0.0.1:1"; // 死端口隔离（缺省 8770 会够得着真壳）
delete process.env.ZAI_CODING_CN_API_KEY;
delete process.env.CONDUCTOR_INBOX_TTL; // 单元面不继承 ambient
delete process.env.ORCH_EVENTS_DIR;
delete process.env.PIANIST_SESSIONS_DIR;

const CWD = path.resolve(import.meta.dirname, "..");
const { Inbox } = await import("../src/orchestrator/inbox.mjs");
const { ApprovalQueue } = await import("../src/queue-core.mjs");
const { nowJstDay } = await import("../src/orchestrator/day-clock.mjs");
const { ttlExpired, parseTtlMode, sweepAccountLine } = await import("../src/inbox-ttl.mjs");

// 固定钟（JST 日界可控）：YESTERDAY=JST 10-18 12:00 / TODAY=JST 10-19 12:00 / TOMORROW=JST 10-20 12:00
const YESTERDAY = Date.parse("2026-10-18T03:00:00.000Z");
const TODAY = Date.parse("2026-10-19T03:00:00.000Z");
const H48 = 48 * 3600_000;
const mkClk = (ms) => { let t = ms; return { get: () => t, set: (x) => { t = x; } }; };

// ---- 前置：写入路径自动打 day（真钟同源，两对象） ----
{
	const ib = new Inbox();
	const it = ib.deliver("通知", { text: "前置" });
	check("前置1：Inbox.deliver() 自动打 day=nowJstDay()（真钟同源，一座钟）",
		it.day === nowJstDay() && typeof it.enqueuedAt === "number", JSON.stringify(it.day));
	const q = new ApprovalQueue(null);
	const card = q.request("bash", { command: "git push --force origin pre" }, "pre-1");
	check("前置2：ApprovalQueue.request() 入队打 day=nowJstDay()", card.day === nowJstDay(), JSON.stringify(card.day));
	check("前置3：记账行形状（清了几条、逐条 id+类型）",
		sweepAccountLine("[x]", [{ id: 3, kind: "交货单" }, { id: "ap_1", kind: "审批卡" }]) === "[x] 收件箱按天清：2 条——3(交货单) ap_1(审批卡)");
}

// ---- 验收1：day=yesterday 交货单 → 首 tick 后消失 + 清理行含 id（真 runtime 钩子，非旁路直调） ----
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-ttl-v1-"));
	const stubPi = path.join(dir, "stub-pi.mjs");
	fs.writeFileSync(stubPi, `console.log("DONE"); process.exit(0);\n`);
	const clk = mkClk(YESTERDAY);
	const { buildRuntime } = await import("../src/orchestrator/runtime.mjs");
	const rt = buildRuntime({
		sheetText: "任务：F2验收1夹具\n预算袋：时长 30 分钟\n角色表：\n  - 角色:施工分身 | 数量:1 | 沙箱:无\n交付物清单：\n  - 无\n验收标准：\n  - 各自归账",
		piBin: stubPi,
		progressDir: path.join(dir, "prog"), telemetryDir: path.join(dir, "tel"), sessionsDir: path.join(dir, "sessions"),
		supervisorCfg: { timeoutMs: 60_000 }, watchman: false, pollApprovals: false,
		now: clk.get,
	});
	rt.inbox.deliver("交货单", { minionId: "m-old", manifest: { tail: "昨天的交货单" } }); // day=2026-10-18（注入钟）
	clk.set(TODAY);
	rt.inbox.deliver("讣告", { minionId: "m-today" }); // day=2026-10-19——当天粮（验收3 阴性对照同夹具）
	const logs = [];
	const origLog = console.log;
	console.log = (...a) => { logs.push(a.join(" ")); };
	try {
		rt.startLoop(20); // 首 tick：inboxDailySweep 先于审批轮/poll/tick/sweep
		await sleep(250);
	} finally { console.log = origLog; rt.stop(); }
	const kinds = rt.inbox.peekAll();
	const line = logs.find((l) => l.includes("收件箱按天清"));
	check("验收1：day=yesterday 交货单首 tick 后消失（startLoop 真钩子路径）",
		!kinds.some((i) => i.payload?.minionId === "m-old") && kinds.some((i) => i.payload?.minionId === "m-today"),
		JSON.stringify(kinds.map((i) => i.payload?.minionId)));
	check("验收1：清理记账行在场且含该条目 id（#1(交货单)）",
		!!line && line.includes("#1(交货单)") && line.includes("[orch-runtime]"), line ?? "(无清理行)");
}

// ---- 验收2：day=yesterday 审批卡 → pending 查不到 + 终态 denied(by=system-expired) 不是空（单元面） ----
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-ttl-v2-"));
	const auditFile = path.join(dir, "audit.jsonl");
	const clk = mkClk(YESTERDAY);
	const q = new ApprovalQueue(auditFile, { now: clk.get });
	const card = q.request("bash", { command: "git push --force origin main" }, "pianist-ttl-1", "验收2夹具");
	check("验收2a：注钟昨日入队 → card.day=2026-10-18", card.day === "2026-10-18", JSON.stringify(card.day));
	clk.set(TODAY);
	const swept = q.sweepExpired();
	check("验收2a：清理清单 1 张、含审批单号与类型",
		swept.length === 1 && swept[0].id === card.id && swept[0].kind === "审批卡", JSON.stringify(swept));
	check("验收2a：pending() 查不到（消费面不把 denied 卡当 pending 透出）", q.pending().length === 0);
	const fin = q.get(card.id); // 模拟等卡消费方拉一次终态
	check("验收2a：终态查询返回 denied(by=system-expired) 决断行不是空",
		fin?.status === "denied" && fin?.decidedBy === "system-expired" && fin?.note === "inbox TTL expired" && typeof fin?.decidedAt === "string",
		JSON.stringify({ status: fin?.status, by: fin?.decidedBy, note: fin?.note }));
	const auditLines = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
	check("验收2a：每张过期卡走 audit() 落账（暗区不许无痕）",
		auditLines.some((l) => l.id === card.id && l.approve === false && l.by === "system-expired" && l.note === "inbox TTL expired"),
		JSON.stringify(auditLines));
	check("验收2a：幂等（已裁决卡不二次裁决）", q.sweepExpired().length === 0 && q.get(card.id).decidedAt === fin.decidedAt);
}

// ---- 验收2b + 3a：真壳 HTTP 面（随机端口，绝不碰 8770）----
{
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-ttl-shell-"));
	const auditFile = path.join(tmpDir, "audit.jsonl");
	const port = 20000 + Math.floor(Math.random() * 25000);
	const shellProc = spawn(process.execPath, ["src/shell.mjs"], {
		cwd: CWD, stdio: ["ignore", "ignore", "inherit"],
		env: {
			...process.env,
			PIANIST_SHELL_PORT: String(port),
			GRIMOIRE_URL: "http://127.0.0.1:41099",
			PIANIST_TELEMETRY_DIR: path.join(tmpDir, "tel"),
			PIANIST_AUDIT_FILE: auditFile,
		},
	});
	process.on("exit", () => { try { shellProc.kill(); } catch {} });
	const base = `http://127.0.0.1:${port}`;
	let up = false;
	for (let i = 0; i < 50 && !up; i++) {
		try { up = (await fetch(`${base}/health`)).ok; } catch { /* 还没起 */ }
		if (!up) await sleep(100);
	}
	check("验收2b：真壳起得来（/health 通）", up);
	if (up) {
		const req = await (await fetch(`${base}/approvals/request`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ agent: "pianist-ttl-2", action: "bash", payload: { command: "git push --force origin main" }, intent: "验收2b夹具" }),
		})).json();
		const cardId = req?.approval?.id;
		check("验收2b：壳入队打 day=nowJstDay()（真钟面）", req?.approval?.day === nowJstDay(), JSON.stringify(req?.approval?.day));
		// sweep 注钟位：now=+48h → 该卡过期（生产不传 now=真钟；这是路由的测试注钟位）
		const sw = await (await fetch(`${base}/approvals/sweep`, {
			method: "POST", headers: { "content-type": "application/json" },
			body: JSON.stringify({ now: Date.now() + H48 }),
		})).json();
		check("验收2b：POST /approvals/sweep 清 1 张（swept 含 id）", sw?.ok === true && sw?.swept?.length === 1 && sw.swept[0].id === cardId, JSON.stringify(sw));
		const pend = (await (await fetch(`${base}/approvals/pending`)).json()).pending;
		check("验收2b（3a）：壳 /approvals/pending 查不到过期卡（消费面不透 denied）",
			!pend.some((c) => c.id === cardId) && pend.length === 0, JSON.stringify(pend.map((c) => c.id)));
		const fin = await (await fetch(`${base}/approvals/get?id=${cardId}`)).json();
		check("验收2b：/approvals/get 终态=denied(by=system-expired) 决断行不是空（等卡消费方拉一次）",
			fin?.status === "denied" && fin?.decidedBy === "system-expired" && fin?.note === "inbox TTL expired", JSON.stringify({ s: fin?.status, by: fin?.decidedBy }));
		const auditLines = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
		check("验收2b：壳审计账落 system-expired 行", auditLines.some((l) => l.id === cardId && l.by === "system-expired"));
		// 3a runtime 消费面：pollApprovals 吃 pending——denied 卡不进收件箱
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-ttl-v2rt-"));
		const { buildRuntime } = await import("../src/orchestrator/runtime.mjs");
		const rt = buildRuntime({
			sheetText: "任务：F2验收2b夹具\n预算袋：时长 30 分钟\n角色表：\n  - 角色:施工分身 | 数量:1 | 沙箱:无\n交付物清单：\n  - 无\n验收标准：\n  - 各自归账",
			progressDir: path.join(dir, "prog"), telemetryDir: path.join(dir, "tel"), sessionsDir: path.join(dir, "sessions"),
			supervisorCfg: { timeoutMs: 60_000 }, watchman: false, shellUrl: base,
		});
		const cards = await rt.pollApprovals();
		check("验收2b（3a）：runtime pollApprovals 不把 denied 卡当 pending 透出（空手不喂噪音）",
			cards.length === 0 && !rt.inbox.peekAll().some((i) => i.kind === "审批"), JSON.stringify(cards.map((c) => c.id)));
		rt.stop();
		// backfill 路由幂等面：新卡全有 day → 实打 0
		const bf = await (await fetch(`${base}/approvals/backfill-day`, {
			method: "POST", headers: { "content-type": "application/json" }, body: "{}",
		})).json();
		check("验收2b：/approvals/backfill-day 幂等面（无存量无 day 卡 → 实打 0、day=部署日真钟）",
			bf?.ok === true && bf?.backfilled?.length === 0 && bf?.day === nowJstDay(), JSON.stringify(bf));
	}
	try { shellProc.kill(); } catch {}
}

// ---- 验收3：day=today 原封不动（阴性对照，两对象） ----
{
	const clk = mkClk(TODAY);
	const ib = new Inbox({ now: clk.get });
	ib.deliver("交货单", { minionId: "m-t" });
	ib.deliver("审批", { id: "ap_today" });
	const q = new ApprovalQueue(null, { now: clk.get });
	q.request("bash", { command: "git push --force origin keep" }, "keep-1");
	const sweptIb = ib.sweepExpired(TODAY);
	const sweptQ = q.sweepExpired(TODAY);
	check("验收3：day=today 条目首 tick 后原封不动（inbox 0 清/2 留 + 审批卡 0 清/pending 在）",
		sweptIb.length === 0 && ib.size() === 2 && sweptQ.length === 0 && q.pending().length === 1,
		JSON.stringify({ sweptIb, sweptQ }));
}

// ---- 验收4：清理零 spawn/relaunch（函数体 grep 机器自证）+ conductor --once 前后 state.watchman 零 diff ----
{
	/** 从源文件提取函数体（花括号配平；模板串内 ${} 自配平）——提取失败返回 null 让 check 出声 */
	function fnBody(src, name) {
		const m = src.match(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(|[\\n\\t](?:async\\s+)?${name}\\s*\\(`));
		if (!m || m.index == null) return null;
		const start = src.indexOf("{", m.index + m[0].length - 1);
		if (start === -1) return null;
		let depth = 0;
		for (let j = start; j < src.length; j++) {
			if (src[j] === "{") depth++;
			else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(start, j + 1); }
		}
		return null;
	}
	const read = (p) => fs.readFileSync(path.join(CWD, p), "utf8");
	const WALL = /\bspawn\b|\brelaunch\b|launchPart|hearthSend|watchmanHandleTaskDeath/;
	const targets = [
		["Inbox.sweepExpired", fnBody(read("src/orchestrator/inbox.mjs"), "sweepExpired")],
		["ApprovalQueue.sweepExpired", fnBody(read("src/queue-core.mjs"), "sweepExpired")],
		["ApprovalQueue.backfillDay", fnBody(read("src/queue-core.mjs"), "backfillDay")],
		["conductor.inboxTtlDailySweep", fnBody(read("src/conductor.mjs"), "inboxTtlDailySweep")],
		["runtime.inboxDailySweep", fnBody(read("src/orchestrator/runtime.mjs"), "inboxDailySweep")],
	];
	for (const [name, body] of targets) {
		check(`验收4：${name} 函数体零 spawn/relaunch（帷幕线：清理≠补发）`,
			body != null && !WALL.test(body), body == null ? "函数体提取失败（挂点被挪？）" : (body.match(WALL) ?? ["?"])[0]);
	}
	const pure = read("src/inbox-ttl.mjs");
	check("验收4：inbox-ttl.mjs 判定件整文件零 spawn/relaunch", !WALL.test(pure));
	const inboxSrc = read("src/orchestrator/inbox.mjs");
	check("验收4：inbox.mjs 整文件零 spawn/relaunch", !/\bspawn\b|\brelaunch\b/.test(inboxSrc));

	// conductor --once：F2 面零接触（--once 不打壳 sweep）+ 清理前后 state.watchman 零 diff
	const CLEAN_ENV = { ...process.env };
	for (const k of Object.keys(CLEAN_ENV)) if (/^CONDUCTOR_/.test(k)) delete CLEAN_ENV[k];
	delete CLEAN_ENV.HEARTH_URL;
	delete CLEAN_ENV.ORCH_EVENTS_DIR;
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-ttl-v4-"));
	const telDir = path.join(tmp, "telemetry"); fs.mkdirSync(telDir, { recursive: true });
	const hotspotOut = path.join(tmp, "hotspots", "latest.json");
	fs.mkdirSync(path.dirname(hotspotOut), { recursive: true });
	fs.writeFileSync(hotspotOut, JSON.stringify({ v: 1, generatedAt: new Date().toISOString(), hotspots: [], errorHotspots: [] }));
	const retroStateFile = path.join(tmp, "retro", "state.json");
	fs.mkdirSync(path.dirname(retroStateFile), { recursive: true });
	fs.writeFileSync(retroStateFile, JSON.stringify({ v: 1, lastRetroAt: new Date().toISOString(), runs: 1 }));
	const piStub = path.join(tmp, "pi-stub.mjs");
	fs.writeFileSync(piStub, "process.exit(0);\n");
	const stateDir = path.join(tmp, "state"); fs.mkdirSync(stateDir, { recursive: true });
	fs.mkdirSync(path.join(tmp, "stig"), { recursive: true });
	const schedFile = path.join(tmp, "schedule.json");
	fs.writeFileSync(schedFile, JSON.stringify({ v: 1, default_permission: "always-ask", entries: [] }));
	const WATCHMAN_FIXTURE = {
		relaunches: { t9: { count: 1, healCount: 0, history: [{ ts: "2026-10-01T00:00:00.000Z", exit: 1 }] } },
		seamShouted: { t8: "2026-10-01T00:00:00.000Z" },
	};
	fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify({ days: {}, launches: [], watchman: WATCHMAN_FIXTURE }));
	const onceEnv = (extra = {}) => ({
		...CLEAN_ENV,
		CONDUCTOR_PARTS: "wander", CONDUCTOR_IDLE_NOW: "1",
		CONDUCTOR_STATE_DIR: stateDir,
		PIANIST_TELEMETRY_DIR: telDir,
		CONDUCTOR_HOTSPOT_OUT: hotspotOut, CONDUCTOR_HOTSPOT_DIR: path.join(tmp, "no-such-dir"),
		CONDUCTOR_RETRO_STATE: retroStateFile,
		CONDUCTOR_PI_BIN: piStub, CONDUCTOR_SCHEDULE_FILE: schedFile,
		CONDUCTOR_ACTIVE_HOURS: "00:00-24:00", CONDUCTOR_STIGMERGY_ROOT: path.join(tmp, "stig"),
		CONDUCTOR_DAILY_BUDGET: "999",
		HEARTH_URL: "http://127.0.0.1:1",
		PIANIST_SHELL_URL: "http://127.0.0.1:1", // 死端口：若 --once 误打壳 sweep，这里出声可见
		PI_STUB_LOG: path.join(tmp, "pi.log"),
		ORCH_EVENTS_DIR: path.join(tmp, "events"),
		...extra,
	});
	const r1 = spawnSync(process.execPath, [path.join(CWD, "src", "conductor.mjs"), "--once"], { env: onceEnv(), encoding: "utf8", timeout: 120_000 });
	const out1 = `${r1.stdout}\n${r1.stderr}`;
	const st1 = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
	check("验收4：conductor --once 跑通（F2 钩子住常驻面，--once 零接触）",
		r1.status === 0 && !out1.includes("收件箱按天清") && !out1.includes("/approvals/sweep"),
		`status=${r1.status} tail=${out1.slice(-200)}`);
	check("验收4：清理前后 state.watchman 零 diff（更夫的账 F2 一笔不动）",
		JSON.stringify(st1.watchman) === JSON.stringify(WATCHMAN_FIXTURE), JSON.stringify(st1.watchman));
	// 三型 env 在 --once 面也不炸（彩排面回 day 不拦路）
	const r2 = spawnSync(process.execPath, [path.join(CWD, "src", "conductor.mjs"), "--once"], { env: onceEnv({ CONDUCTOR_INBOX_TTL: "24h" }), encoding: "utf8", timeout: 120_000 });
	check("验收4：CONDUCTOR_INBOX_TTL=24h 下 --once 照跑（彩排面不设卡）", r2.status === 0, `${r2.status} ${(r2.stderr || "").slice(-200)}`);
}

// ---- 验收5：env 三型各跑一遍清理判定 + 非法值常驻面 fail-fast ----
{
	const NOW = TODAY; // JST 10-19 12:00
	const mkFixture = () => {
		const clk = mkClk(NOW - 30 * 3600_000); // 30h 前入队（day=2026-10-18）
		const ib = new Inbox({ now: clk.get });
		ib.deliver("交货单", { minionId: "old-货" }); // seq1：30h 前交货单
		ib.deliver("审批", { id: "ap_old" });        // seq2：30h 前审批卡
		clk.set(NOW);
		ib.deliver("交货单", { minionId: "new-货" }); // seq3：刚入队（day=2026-10-19）
		return ib;
	};
	const dayIb = mkFixture();
	const daySwept = dayIb.sweepExpired(NOW, "day");
	check("验收5：day 型清理判定（正典 A：隔夜粮清、当天粮留）",
		JSON.stringify(daySwept.map((s) => s.seq)) === JSON.stringify([1, 2]) && dayIb.size() === 1, JSON.stringify(daySwept.map((s) => s.seq)));
	const h24Ib = mkFixture();
	const h24Swept = h24Ib.sweepExpired(NOW, "24h");
	check("验收5：24h 型清理判定（B 逃生门：30h 前两条清、刚入队留——不看 day 看钟龄）",
		JSON.stringify(h24Swept.map((s) => s.seq)) === JSON.stringify([1, 2]) && h24Ib.size() === 1, JSON.stringify(h24Swept.map((s) => s.seq)));
	const tieredIb = mkFixture();
	const tieredSwept = tieredIb.sweepExpired(NOW, "tiered");
	check("验收5：tiered 型清理判定（C 逃生门：审批卡 72h 长窗——30h 审批留、30h 交货单清）",
		JSON.stringify(tieredSwept.map((s) => s.seq)) === JSON.stringify([1]) && tieredIb.size() === 2, JSON.stringify(tieredSwept.map((s) => s.seq)));
	check("验收5：三型判词分叉（同夹具不同 verdict——模式真在读不是摆设）",
		ttlExpired("day", { day: "2026-10-19", atMs: NOW - 30 * 3600_000, kind: "交货单" }, NOW) === false
		&& ttlExpired("24h", { day: "2026-10-19", atMs: NOW - 30 * 3600_000, kind: "交货单" }, NOW) === true
		&& ttlExpired("tiered", { day: "2026-10-19", atMs: NOW - 30 * 3600_000, kind: "审批卡" }, NOW) === false
		&& ttlExpired("day", { day: "2026-10-18", atMs: NOW - 30 * 3600_000, kind: "交货单" }, NOW) === true);
	check("验收5：parseTtlMode 三型原样/缺省回 day/大小写敏感非法即 null",
		parseTtlMode("day") === "day" && parseTtlMode("24h") === "24h" && parseTtlMode("tiered") === "tiered"
		&& parseTtlMode(undefined) === "day" && parseTtlMode("") === "day" && parseTtlMode("  ") === "day"
		&& parseTtlMode("weekly") === null && parseTtlMode("DAY") === null);
	// 非法值：conductor 常驻面 fail-fast（exit 1 + 出声，别静默）
	const CLEAN_ENV = { ...process.env };
	for (const k of Object.keys(CLEAN_ENV)) if (/^CONDUCTOR_/.test(k)) delete CLEAN_ENV[k];
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-ttl-v5-"));
	const bad = spawnSync(process.execPath, [path.join(CWD, "src", "conductor.mjs")], {
		env: {
			...CLEAN_ENV, CONDUCTOR_INBOX_TTL: "weekly", CONDUCTOR_SKIP_UNIT_CHECK: "1",
			CONDUCTOR_STATE_DIR: path.join(tmp, "state"), PIANIST_TELEMETRY_DIR: path.join(tmp, "tel"),
			HEARTH_URL: "http://127.0.0.1:1", PIANIST_SHELL_URL: "http://127.0.0.1:1",
		},
		encoding: "utf8", timeout: 30_000,
	});
	check("验收5：非法值 conductor 常驻面 fail-fast（exit 1 + 出声点破 env 名）",
		bad.status === 1 && `${bad.stdout}\n${bad.stderr}`.includes("CONDUCTOR_INBOX_TTL"),
		`status=${bad.status} out=${(`${bad.stdout}\n${bad.stderr}`).slice(-200)}`);
}

// ---- 验收6：假钟跨界（单点钟）——同一注入钟写入与清判一致，无死区 ----
{
	const PRE = Date.parse("2026-10-19T14:59:59.999Z"); // JST 2026-10-19 23:59:59.999
	const POST = Date.parse("2026-10-19T15:00:00.000Z"); // JST 2026-10-20 00:00:00.000（+1ms 日界翻篇）
	const ib = new Inbox({ now: () => PRE });
	const it = ib.deliver("交货单", { minionId: "m-skew" });
	check("验收6：写入 day 与 nowJstDay(同一注入钟) 一致（一套钟，两把刀共用）",
		it.day === nowJstDay(PRE) && it.day === "2026-10-19", JSON.stringify(it.day));
	check("验收6：刚写入即扫不清（同钟无「刚写入即过期」死区）", ib.sweepExpired(PRE).length === 0 && ib.size() === 1);
	const swept = ib.sweepExpired(POST);
	check("验收6：日界 +1ms 同钟即清（无「永不过期」死区）",
		swept.length === 1 && swept[0].day === "2026-10-19" && ib.size() === 0, JSON.stringify(swept));
	const q = new ApprovalQueue(null, { now: () => PRE });
	const c = q.request("bash", { command: "git push --force origin skew" }, "skew-1");
	check("验收6：审批卡同款——PRE 写入 PRE 扫不清", c.day === nowJstDay(PRE) && q.sweepExpired(PRE).length === 0 && q.pending().length === 1);
	check("验收6：审批卡同款——POST 扫即清（denied）", q.sweepExpired(POST).length === 1 && q.get(c.id)?.decidedBy === "system-expired");
}

// ---- 验收7：存量卡补打（施工读法 A 钉；B 读法反面证据 + 迁移闭环 + 工具黑盒） ----
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-ttl-v7-"));
	const auditFile = path.join(dir, "audit.jsonl");
	const q = new ApprovalQueue(auditFile); // 真钟（部署日不是注入位）
	const card = q.request("bash", { command: "git reset --hard HEAD~9" }, "legacy-10-12");
	delete card.day; // 模拟 10/12-13 存量旧形（无 day 字段）
	check("验收7：B 读法反面证据——无 day 旧卡在 day 正典下永不清（不 fallback，钉 A 的动机）",
		q.sweepExpired(Date.now() + H48).length === 0 && q.pending().length === 1);
	const { day, backfilled } = q.backfillDay(); // 迁移：补打 day=部署日（真钟）
	check("验收7：迁移补打 day=部署日（真钟 nowJstDay，幂等面在）",
		backfilled.length === 1 && day === nowJstDay() && card.day === day, JSON.stringify({ day, card: card.day }));
	check("验收7：迁移幂等（已有 day 不动）", q.backfillDay().backfilled.length === 0 && card.day === day);
	check("验收7：迁移当日不清（阴性对照——补打不是当庭清杀）", q.sweepExpired().length === 0 && q.pending().length === 1);
	const swept = q.sweepExpired(Date.now() + H48); // 次日首 tick（+48h 跨两日界）
	const line = sweepAccountLine("[conductor]", swept);
	check("验收7：次日首 tick 被清 + 清理行含其 id（审批单号）",
		swept.length === 1 && swept[0].id === card.id && line.includes(card.id), line);
	const auditLines = fs.readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	check("验收7：迁移与过期都落审计（migrate 行 + system-expired 行，不留暗账）",
		auditLines.some((l) => l.id === card.id && l.migrate === true && l.by === "system-migrate")
		&& auditLines.some((l) => l.id === card.id && l.by === "system-expired"),
		JSON.stringify(auditLines));

	// 工具黑盒：spawnSync 直跑 tools/migrate-inbox-day.mjs（不 import 内部）。mock 壳必须独立进程：
	// spawnSync 会阻塞父进程事件循环，同进程 http server 根本没法应答（工具 fetch 必超时——实测坑）。
	// mock 落账：backfill 调用写日志文件，跨进程可断言。
	const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), "inbox-ttl-mock-"));
	const mockFile = path.join(mockDir, "mock-shell.mjs");
	const backfillLog = path.join(mockDir, "backfill.log");
	fs.writeFileSync(mockFile, `
import http from "node:http";
import fs from "node:fs";
const logFile = process.argv[2];
const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const server = http.createServer((req, res) => {
	if (req.method === "GET" && req.url === "/approvals/pending") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ pending: [
			{ id: "ap_old_9", status: "pending", agent: "legacy", action: "bash" },
			{ id: "ap_new_1", status: "pending", day: "2026-10-19", agent: "new", action: "bash" },
		] }));
		return;
	}
	if (req.method === "POST" && req.url === "/approvals/backfill-day") {
		let body = "";
		req.on("data", (c) => { body += c; });
		req.on("end", () => {
			fs.appendFileSync(logFile, body + "\\n");
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, day: today, backfilled: [{ id: "ap_old_9", kind: "审批卡", agent: "legacy" }] }));
		});
		return;
	}
	res.writeHead(404); res.end("{}");
});
server.listen(0, "127.0.0.1", () => process.stdout.write("PORT:" + server.address().port));
`.replaceAll("\n\t", "\n"));
	const mockProc = spawn(process.execPath, [mockFile, backfillLog], { stdio: ["ignore", "pipe", "inherit"] });
	process.on("exit", () => { try { mockProc.kill(); } catch {} });
	let mockPort = null;
	{
		let buf = "";
		mockProc.stdout.on("data", (d) => {
			buf += d.toString();
			const m = /PORT:(\d+)/.exec(buf);
			if (m) mockPort = Number(m[1]);
		});
		const t0 = Date.now();
		while (!mockPort && Date.now() - t0 < 10_000) await sleep(50);
	}
	check("验收7：mock 壳起得来（独立进程）", mockPort != null);
	const backfillCalls = () => (fs.existsSync(backfillLog) ? fs.readFileSync(backfillLog, "utf8").trim().split("\n").filter(Boolean) : []);
	const runTool = (extra) => spawnSync(process.execPath, [path.join(CWD, "tools", "migrate-inbox-day.mjs"), ...extra], {
		encoding: "utf8", timeout: 30_000,
		env: { ...process.env, PIANIST_SHELL_URL: "http://127.0.0.1:1" }, // --url 必须压过 env 死端口
	});
	if (mockPort != null) {
		const dry = runTool(["--url", `http://127.0.0.1:${mockPort}`, "--dry-run"]);
		check("验收7：工具 --dry-run 只报不写（mock 壳零 backfill 调用、报出存量 id）",
			dry.status === 0 && dry.stdout.includes("ap_old_9") && dry.stdout.includes("dry-run") && backfillCalls().length === 0,
			`status=${dry.status} calls=${backfillCalls().length} out=${dry.stdout.slice(-200)}`);
		const real = runTool(["--url", `http://127.0.0.1:${mockPort}`]);
		check("验收7：工具真跑补打（--url 压过 env；POST backfill；报补打完成）",
			real.status === 0 && backfillCalls().length === 1 && real.stdout.includes("ap_old_9") && real.stdout.includes("补打完成"),
			`status=${real.status} calls=${backfillCalls().length} out=${real.stdout.slice(-200)}`);
	}
	const dead = runTool(["--url", "http://127.0.0.1:1"]);
	check("验收7：壳够不着 fail-fast（exit 1 + 出声，不静默退出 0）",
		dead.status === 1 && dead.stderr.includes("够不着壳"), `status=${dead.status}`);
	try { mockProc.kill(); } catch {}
}

console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
