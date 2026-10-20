// v2-2 第二铲：retropad 收编编排器回归测试（零真钱——ORCH_PI_BIN 全程指 stub，真 pi 拉起数=0）。
// 断言面（任务书验收标准逐条落位）：
//   - spawn 有台账行、心跳双源（会话 mtime+遥测 tail）喂进 ledger、收尾交货单进收件箱；
//   - 裁决从交货单 manifest.tail 提取，candidate 投 Grimoire 链路保持；
//   - 阴性对照：触发器不满足 → retropad 不拉起（零热点也合法收工，双重阴性）；
//   - 触发器三源经 retropad 各自拉起：threshold（热点≥阈）/ hook（--hook 收尾钩子位）；
//   - 旧三路径行为保持：dry-run 不投 / 零热点早退 / 报告形状坏 exit 2 / 无合法裁决 exit 3 / 超时讣告 exit 3。
// 突变敏感（复验者亲手掰）：
//   - 拆掉触发器闸（retropad 不再 evaluate）→ 阴性对照组必红（marker 出现=偷偷拉了分身）；
//   - 拆掉 buildRuntime/launchMinion（退回裸 spawn）→ 「台账/交货单/心跳源」断言必红；
//   - 拆掉交货单取裁决（回 stdout 提取）→ 「交货单：进收件箱」与裁决断言必红。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";

// ---- 夹具隔离（纪律）：凭证/进度/遥测/会话目录全指 tmp，不写生产路径 ----
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "retropad-orch-"));
const credDir = path.join(tmpRoot, "cred");
const journalFile = path.join(tmpRoot, "journal.jsonl");
const progressDir = path.join(tmpRoot, "progress");
const telemetryDir = path.join(tmpRoot, "telemetry");
const sessionsDir = path.join(tmpRoot, "sessions");
for (const d of [credDir, progressDir, telemetryDir, sessionsDir]) fs.mkdirSync(d, { recursive: true });
const V_FIXTURE = "retro-orch-test-key-never-printed";
fs.writeFileSync(path.join(credDir, "coding-plan"), V_FIXTURE);
process.env.PORTALK_CRED_DIR = credDir;
process.env.PORTALK_CRED_JOURNAL = journalFile;
process.env.ORCH_PROGRESS_DIR = progressDir;
process.env.PIANIST_TELEMETRY_DIR = telemetryDir;
process.env.PIANIST_SESSIONS_DIR = sessionsDir;
delete process.env.ZAI_CODING_CN_API_KEY; // 剥 ambient——走柜路径（本测试全程 stub，钥匙只是过账）

let pass = 0, total = 0;
function check(name, ok, extra) {
	total++;
	if (ok) pass++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra !== undefined && !ok ? " — " + extra : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- stub pi（学 orch-real-driver 的写法：.mjs 后缀直接当入口，env 驱动行为）----
// 行为：写遥测 beat（源②）+ 预置会话文件 mtime 推进（源①）+ 输出裁决 JSON+DONE；
// marker 落盘=「真被 spawn 过」的物证（阴性对照靠它证不拉起）。
const stubPath = path.join(tmpRoot, "stub-pi.mjs");
fs.writeFileSync(stubPath, `import fs from "node:fs";
import path from "node:path";
const mode = process.env.RETRO_STUB_MODE ?? "candidates";
const marker = process.env.RETRO_STUB_MARKER ?? "";
const sessFile = process.env.RETRO_STUB_SESSION_FILE ?? "";
const beat = (tool) => {
	const dir = process.env.PIANIST_TELEMETRY_DIR;
	if (!dir) return;
	const file = path.join(dir, (process.env.PIANIST_AGENT_ID ?? "orch-x") + "-" + new Date().toISOString().slice(0, 10) + ".jsonl");
	fs.appendFileSync(file, JSON.stringify({ v: 1, ts: new Date().toISOString(), kind: "tool_use", data: { tool, input: { command: "echo" }, isError: false } }) + "\\n");
};
if (process.env.RETRO_STUB_DUMP) fs.writeFileSync(process.env.RETRO_STUB_DUMP, process.argv.join("\\n")); // 截获任务书全文（活/旧账标记断言面）
if (marker) fs.appendFileSync(marker, "spawned mode=" + mode + "\\n");
if (mode === "candidates" || mode === "nothing" || mode === "garbage" || mode === "tickets" || mode === "ticket-bad") {
	beat("pianist_bridge");
	if (sessFile) {
		fs.mkdirSync(path.dirname(sessFile), { recursive: true });
		fs.writeFileSync(sessFile, "{\\"type\\":\\"session\\"}\\n");
		await new Promise((r) => setTimeout(r, 300));
		fs.utimesSync(sessFile, new Date(), new Date()); // mtime 推进 = 心跳源①（会话文件）
	}
	beat("pianist_bridge");
	if (mode === "candidates") {
		console.log("经图查完，无近亲撞名。");
		console.log(JSON.stringify({ verdict: "candidates", health: "n/a", candidates: [{ name: "auto-stub-skill", tags: ["self-learning"], body: "body-b", trigger: "trigger-t", boundary: "boundary-b", why: "why-w" }], note: "stub 一场收工" }));
	} else if (mode === "nothing") {
		console.log(JSON.stringify({ verdict: "nothing", health: "n/a", note: "本场没有值得记的" }));
	} else if (mode === "tickets") {
		console.log(JSON.stringify({ verdict: "nothing", health: "n/a", tickets: [
			{ title: "bridge-spoor-unwired", detail: "桥未接线快失败×29——环境传感非认知浪费", evidence: "pianist-dev-1-2026-09-26.jsonl#5" },
			{ title: "bridge-status-fastfail", detail: "status 动作占位快失败×12", evidence: "pianist-dev-1-2026-10-06.jsonl#9" },
		], note: "两单工单，nothing 收工" }));
	} else if (mode === "ticket-bad") {
		console.log(JSON.stringify({ verdict: "nothing", health: "n/a", tickets: "not-an-array", note: "坏形状" }));
	} else {
		console.log("我觉得挺好的（无 JSON 裁决形状）");
	}
	console.log("DONE");
	process.exit(0);
}
setInterval(() => {}, 1073741824); // hang：等双时钟收
`);
process.env.ORCH_PI_BIN = stubPath; // 零真钱：driver 入口解析必落 stub

// ---- mock 壳：grimoire_darkzone（draft 名单）+ grimoire_submit（记账） ----
const submits = [];
const darkzoneText = [
	"暗区点名(从未被push/expand):",
	"env-facts-probe  [draft层/draft]",
	"some-verified-skill  [canon/verified]",
	"",
	"出口提醒: 名单是机械的, 逐本判断仍是巡山使的活。",
].join("\n");
const mockShell = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => { body += c; });
	req.on("end", () => {
		let parsed = null;
		try { parsed = JSON.parse(body); } catch { /* 坏包回 400 */ }
		if (req.url === "/tools/invoke" && parsed?.action === "grimoire_darkzone") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: 200, body: darkzoneText }));
			return;
		}
		if (req.url === "/tools/invoke" && parsed?.action === "grimoire_submit") {
			submits.push(parsed);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: 200, body: "ok" }));
			return;
		}
		res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ status: 400, body: "nope" }));
	});
});
await new Promise((r) => mockShell.listen(18781, "127.0.0.1", r));

const ROOT = path.resolve(import.meta.dirname, "..");
const { writeRetroState, readRetroState } = await import("../src/orchestrator/retro-trigger.mjs");

function runRetropad(argv, envOverrides = {}) {
	// 测试密封（10-17 补）：retropad 读面也隔离——缺省 --tickets 指到空夹具，
	// 防「既有工单 open 名单」段带出生产 data/retro/tickets.jsonl 的内容
	// （首捕实录：转发工单 detail 含「裁决后新事=无」字样，污染 4.7 活/旧账计数断言）。
	// 显式传了 --tickets 的调用（既有工单段专测）不受影响。
	const args = argv.includes("--tickets")
		? argv
		: [...argv.slice(0, 2), "--tickets", path.join(tmpRoot, "tickets-sealed-empty.jsonl"), ...argv.slice(2)];
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [path.join(ROOT, "src", "retropad.mjs"), ...args], {
			cwd: ROOT,
			env: { ...process.env, ...envOverrides },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "", err = "";
		child.stdout.on("data", (d) => { out += d.toString(); });
		child.stderr.on("data", (d) => { err += d.toString(); });
		const guard = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 90_000);
		child.on("close", (code) => { clearTimeout(guard); resolve({ code, out, err }); });
	});
}

const sessSubDir = path.join(sessionsDir, "--retro-test--");
const sessName = () => new Date().toISOString().replace(/[:.]/g, "-").replace(/(\d{2})-(\d{3})Z$/, "$1-$2Z") + "_stub.jsonl";
/** 预置一个发车窗内的会话文件（stub 跑中 utimes 它 → 心跳源①）；marker 物证文件 */
function freshFixtures(caseName) {
	const sessFile = path.join(sessSubDir, sessName());
	fs.mkdirSync(sessSubDir, { recursive: true });
	fs.writeFileSync(sessFile, "{\"type\":\"session\"}\n");
	const marker = path.join(tmpRoot, `marker-${caseName}`);
	return { sessFile, marker };
}
const reportPath = (n, e = 0) => {
	const p = path.join(tmpRoot, `report-${n + "e" + e}-${Date.now()}.json`);
	fs.writeFileSync(p, JSON.stringify({
		v: 1, generatedAt: new Date().toISOString(), params: {},
		hotspots: Array.from({ length: n }, (_, i) => ({
			agent: "pianist-dev-1", occurrences: 9, convergence: 1, windowFp: `fp-${i}`, topExecShape: "bash:echo",
			firstTs: "t0", lastTs: "t1", evidence: { file: `/tmp/x${i}.jsonl`, line: 1, lastLine: 2 },
		})),
		errorHotspots: Array.from({ length: e }, (_, i) => ({
			agent: "pianist-dev-2", count: 4, shape: "bash:npm test*", firstTs: "t0", lastTs: "t1",
			evidence: [{ file: `/tmp/y${i}.jsonl`, line: 1 }],
		})),
	}));
	return p;
};

// ============ 1) 端到端正向：threshold 源 → 编排器拉起 → 双源心跳 → 交货单 → 投 Grimoire → 状态落账 ============
{
	const { sessFile, marker } = freshFixtures("e2e");
	const state = path.join(tmpRoot, "state-e2e.json");
	const report = reportPath(3, 0); // 3 热点 ≥ 阈 3 → threshold 源燃
	const submitsBefore = submits.length;
	const r = await runRetropad(["--report", report, "--state", state], {
		RETRO_STUB_MODE: "candidates", RETRO_STUB_MARKER: marker, RETRO_STUB_SESSION_FILE: sessFile,
		PIANIST_SHELL_URL: "http://127.0.0.1:18781",
	});
	check("端到端：exit 0", r.code === 0, JSON.stringify({ code: r.code, tail: r.out.slice(-400), err: r.err.slice(-200) }));
	check("端到端：触发器 threshold 源燃（reason=threshold）", r.out.includes("reason=threshold"), r.out.slice(0, 400));
	check("端到端：draft 近亲名单拉到（roster 链路保持）", r.out.includes("draft 近亲名单：1 本"));
	check("端到端：spawn 有台账行且状态=收（收编编排器的物证——裸 spawn 拆回去这行就没了）",
		/台账：\S+ 状态=收 /.test(r.out), r.out.split("\n").filter((l) => l.includes("台账")).join("|"));
	check("端到端：心跳双源喂进 ledger（遥测 tail + 会话 mtime）",
		/心跳源=(telemetry\+session|session\+telemetry)/.test(r.out) && /心跳=\d{4}-/.test(r.out),
		r.out.split("\n").filter((l) => l.includes("台账") || l.includes("心跳")).join("|"));
	check("端到端：交货单进收件箱（manifest.tail 采集位）", r.out.includes("交货单：进收件箱"));
	check("端到端：裁决从交货单提取（candidates）+ 健康问落账",
		r.out.includes("分身裁决: candidates") && r.out.includes("健康问: n/a"));
	check("端到端：candidate 投 Grimoire（author=retropad-1）",
		submits.length === submitsBefore + 1 && submits.at(-1).payload.name === "auto-stub-skill" && submits.at(-1).payload.author === "retropad-1",
		JSON.stringify(submits.slice(-1)));
	check("端到端：stub 真被 spawn 过（marker 物证）", fs.existsSync(marker) && fs.readFileSync(marker, "utf8").includes("candidates"));
	const st = readRetroState(state);
	check("端到端：合法收工写复盘状态（lastRetroAt+runs=1+verdict——due 源下次读它）",
		st.source === "json" && st.raw.runs === 1 && st.raw.verdict === "candidates" && st.raw.reason === "threshold", JSON.stringify(st.raw));
	// 状态接线：刚盘完 → 未到期 → 热点降到阈下再来一趟（无 force/hook）不拉分身
	// （用 1 热点报告：阈值源不燃，只剩 due 可判——状态文件回喂的效果才隔离得出来）
	const { marker: marker2 } = freshFixtures("e2e-retick");
	const r2 = await runRetropad(["--report", reportPath(1), "--state", state], {
		RETRO_STUB_MODE: "candidates", RETRO_STUB_MARKER: marker2, PIANIST_SHELL_URL: "http://127.0.0.1:18781",
	});
	check("端到端：盘完即锁间隔（状态文件回喂触发器 → reason=none 不再拉）",
		r2.code === 0 && r2.out.includes("reason=none") && !fs.existsSync(marker2), r2.out.slice(0, 500));
}

// ============ 2) 阴性对照甲：触发器不满足 → 不拉起（合法收工） ============
{
	const { marker } = freshFixtures("none");
	const state = path.join(tmpRoot, "state-none.json");
	writeRetroState(state, Date.now() - 3_600_000, {}); // 1h 前刚盘完 < 6h 间隔
	const submitsBefore = submits.length;
	const r = await runRetropad(["--report", reportPath(1), "--state", state], {
		RETRO_STUB_MODE: "candidates", RETRO_STUB_MARKER: marker, PIANIST_SHELL_URL: "http://127.0.0.1:18781",
	});
	check("阴性·触发器：三源全不满足 → exit 0 不拉分身（marker 无物证=零 spawn）",
		r.code === 0 && r.out.includes("触发器不满足") && !fs.existsSync(marker), r.out.slice(0, 500));
	check("阴性·触发器：不投 Grimoire、状态不被改（lastRetroAt 仍 1h 前）",
		submits.length === submitsBefore && readRetroState(state).raw.runs === 1, JSON.stringify(readRetroState(state).raw));
}

// ============ 3) 阴性对照乙：零热点 → 不拉分身（闸门三原样） ============
{
	const { marker } = freshFixtures("zero");
	const r = await runRetropad(["--report", reportPath(0), "--state", path.join(tmpRoot, "state-zero.json")], {
		RETRO_STUB_MODE: "candidates", RETRO_STUB_MARKER: marker, PIANIST_SHELL_URL: "http://127.0.0.1:18781",
	});
	check("阴性·零热点：exit 0 + 原话在（没有事件就没有进程）+ 零 spawn",
		r.code === 0 && r.out.includes("报告零热点") && !fs.existsSync(marker), r.out.slice(0, 300));
}

// ============ 4) hook 源经 retropad：--hook（收尾钩子位）独立拉起 ============
{
	const { sessFile, marker } = freshFixtures("hook");
	const state = path.join(tmpRoot, "state-hook.json");
	writeRetroState(state, Date.now() - 3_600_000, {}); // 未到期 + 热点 1<3：只有钩子能拉
	const r = await runRetropad(["--report", reportPath(1), "--state", state, "--hook"], {
		RETRO_STUB_MODE: "nothing", RETRO_STUB_MARKER: marker, RETRO_STUB_SESSION_FILE: sessFile,
		PIANIST_SHELL_URL: "http://127.0.0.1:18781",
	});
	check("hook 源：--hook 独立拉起（reason=hook，marker 有物证）",
		r.code === 0 && r.out.includes("reason=hook") && fs.existsSync(marker), r.out.slice(0, 500));
	check("hook 源：verdict=nothing 合法收工（不投）+ 状态落账",
		r.out.includes("本场没有值得记的") && submits.every((s) => s.payload.name !== "x") && readRetroState(state).raw.verdict === "nothing");
}

// ============ 4.5) v2-2.1 tickets 出口：nothing 带工单收工 + 同名去重幂等 ============
{
	const { marker } = freshFixtures("tickets");
	const state = path.join(tmpRoot, "state-tickets.json");
	const ticketsFile = path.join(tmpRoot, "tickets-x.jsonl");
	// 预落一张同名工单（title 与 stub 报的第一单相同）——首跑就该去重它
	fs.writeFileSync(ticketsFile, JSON.stringify({ v: 1, ts: "t0", taskId: "prev-run", title: "bridge-spoor-unwired", detail: "旧单", evidence: "e0", status: "open" }) + "\n");
	const r = await runRetropad(["--report", reportPath(3), "--state", state, "--tickets", ticketsFile], {
		RETRO_STUB_MODE: "tickets", RETRO_STUB_MARKER: marker, PIANIST_SHELL_URL: "http://127.0.0.1:18781",
	});
	check("tickets：exit 0，nothing 带工单收工原话在", r.code === 0 && r.out.includes("本场没有值得记的"), JSON.stringify({ code: r.code, tail: r.out.slice(-300) }));
	check("tickets：同名去重只落新单（新落 1 / 报来 2，旧单 bridge-spoor-unwired 被去重）",
		r.out.includes("工单合计：新落 1 / 报来 2（同名去重 1）"), r.out.split("\n").filter((l) => l.includes("工单")).join("|"));
	const lines = fs.readFileSync(ticketsFile, "utf8").split("\n").filter((l) => l.trim());
	check("tickets：jsonl 恰 2 行（预置 1 + 新落 1），新行带 taskId/status=open",
		lines.length === 2 && JSON.parse(lines[1]).title === "bridge-status-fastfail" && JSON.parse(lines[1]).status === "open" && JSON.parse(lines[1]).taskId.startsWith("retro-"),
		JSON.stringify(lines));
	const st = readRetroState(state);
	check("tickets：状态落账 verdict=nothing 且 tickets=1（新落数进账）", st.raw.verdict === "nothing" && st.raw.tickets === 1, JSON.stringify(st.raw));
	// 第二跑：两张都已在册 → 全去重，jsonl 不再增长（幂等）
	const r2 = await runRetropad(["--report", reportPath(3), "--state", state, "--tickets", ticketsFile], {
		RETRO_STUB_MODE: "tickets", RETRO_STUB_MARKER: marker, PIANIST_SHELL_URL: "http://127.0.0.1:18781",
	});
	const lines2 = fs.readFileSync(ticketsFile, "utf8").split("\n").filter((l) => l.trim());
	check("tickets·幂等：第二跑全去重（新落 0），jsonl 仍 2 行",
		r2.code === 0 && r2.out.includes("新落 0 / 报来 2（同名去重 2）") && lines2.length === 2, r2.out.split("\n").filter((l) => l.includes("工单")).join("|"));
}
// ============ 4.6) v2-2.1 tickets 形状坏：exit 3 不落账 ============
{
	const { marker } = freshFixtures("ticketbad");
	const state = path.join(tmpRoot, "state-ticketbad.json");
	const ticketsFile = path.join(tmpRoot, "tickets-bad.jsonl");
	const r = await runRetropad(["--report", reportPath(3), "--state", state, "--tickets", ticketsFile], {
		RETRO_STUB_MODE: "ticket-bad", RETRO_STUB_MARKER: marker, PIANIST_SHELL_URL: "http://127.0.0.1:18781",
	});
	check("tickets 形状坏：exit 3 + 出声（要数组），工单文件不创建，state 落 failed 账（v3 三修③死亡落账）",
		r.code === 3 && r.err.includes("tickets 字段形状坏") && !fs.existsSync(ticketsFile) && readRetroState(state).raw?.verdict === "failed",
		JSON.stringify({ code: r.code, err: r.err.slice(0, 200), raw: readRetroState(state).raw }));
}

// ============ 4.7) 活/旧账标记进任务书（裁决回灌第二面：due 发车不再让分身盲判旧账） ============
{
	const { marker } = freshFixtures("livemark");
	const dump = path.join(tmpRoot, "dump-livemark.txt");
	const state = path.join(tmpRoot, "state-livemark.json");
	const adj = Date.now() - 3_600_000; // 上次合法裁决 1h 前（未到 due——逼 threshold 源，与标记同源可对账）
	writeRetroState(state, adj, {});
	const rep = path.join(tmpRoot, "report-livemark.json");
	fs.writeFileSync(rep, JSON.stringify({
		v: 1, generatedAt: new Date().toISOString(), params: {},
		hotspots: [
			{ agent: "pianist-dev-1", occurrences: 9, convergence: 1, windowFp: "fp-live-1", topExecShape: "bash:echo", firstTs: "t0", lastTs: new Date(adj + 600_000).toISOString(), evidence: { file: "/tmp/l1.jsonl", line: 1, lastLine: 2 } },
			{ agent: "pianist-dev-1", occurrences: 9, convergence: 1, windowFp: "fp-stale-1", topExecShape: "bash:echo", firstTs: "t0", lastTs: new Date(adj - 600_000).toISOString(), evidence: { file: "/tmp/l2.jsonl", line: 1, lastLine: 2 } },
			{ agent: "pianist-dev-1", occurrences: 9, convergence: 1, windowFp: "fp-live-2", topExecShape: "bash:echo", firstTs: "t0", lastTs: new Date(adj + 1_200_000).toISOString(), evidence: { file: "/tmp/l3.jsonl", line: 1, lastLine: 2 } },
		],
		errorHotspots: [
			{ agent: "pianist-dev-2", count: 4, shape: "bash:npm test*", firstTs: "t0", lastTs: new Date(adj + 600_000).toISOString(), evidence: [{ file: "/tmp/e1.jsonl", line: 1 }] },
			{ agent: "pianist-dev-2", count: 4, shape: "bash:git*", firstTs: "t0", lastTs: new Date(adj - 60_000).toISOString(), evidence: [{ file: "/tmp/e2.jsonl", line: 1 }] },
		],
	}));
	const r = await runRetropad(["--report", rep, "--state", state], {
		RETRO_STUB_MODE: "nothing", RETRO_STUB_MARKER: marker, RETRO_STUB_DUMP: dump,
		PIANIST_SHELL_URL: "http://127.0.0.1:18781",
	});
	const sheet = fs.existsSync(dump) ? fs.readFileSync(dump, "utf8") : "";
	const line = (frag) => sheet.split("\n").find((l) => l.includes(frag)) ?? "";
	check("活/旧账：threshold 以 3/5 活点火（活形状才供弹——与标记同源对账）",
		r.code === 0 && r.out.includes("reason=threshold") && r.out.includes("3/5"), r.out.slice(0, 400));
	check("活/旧账：任务书热点行带裁决后新事标记（3 有 + 2 无，逐条对应）",
		(sheet.match(/裁决后新事=有/g) ?? []).length === 3 && (sheet.match(/裁决后新事=无/g) ?? []).length === 2,
		sheet.split("\n").filter((l) => l.includes("[重复]") || l.includes("[错误]")).join(" | "));
	check("活/旧账：旧账行不误标活（fp-stale-1 与 git* 两行恰是「无」）",
		line("fp-stale-1").includes("裁决后新事=无") && line("bash:git*").includes("裁决后新事=无") && !line("fp-stale-1").includes("裁决后新事=有"),
		JSON.stringify({ stale: line("fp-stale-1"), git: line("bash:git*") }));
	check("活/旧账：判断纪律注解进任务书（旧账=维持原判别硬造——防重复推导反哺裁决层）",
		sheet.includes("对同一份证据重复推导正是本闭环要编译掉的浪费"));
}

// ============ 5) dry-run：裁决照采、candidate 不投（旧路径行为保持） ============
{
	const { marker } = freshFixtures("dry");
	const state = path.join(tmpRoot, "state-dry.json");
	const submitsBefore = submits.length;
	const r = await runRetropad(["--report", reportPath(3), "--state", state, "--dry-run"], {
		RETRO_STUB_MODE: "candidates", RETRO_STUB_MARKER: marker, PIANIST_SHELL_URL: "http://127.0.0.1:18781",
	});
	check("dry-run：exit 0、candidate 打印不投（Grimoire 零新增）",
		r.code === 0 && r.out.includes("dry-run：1 个 candidate 不投") && r.out.includes("auto-stub-skill") && submits.length === submitsBefore,
		r.out.slice(-600));
	check("dry-run：dry-run 也算合法收工（状态落账 verdict=candidates）", readRetroState(state).raw.verdict === "candidates");
}

// ============ 6) 报告形状坏/不可读：exit 2 原样（旧路径行为保持） ============
{
	const r1 = await runRetropad(["--report", path.join(tmpRoot, "no-such-report.json"), "--state", path.join(tmpRoot, "s.json")], {});
	check("报告不可读：exit 2 + 原话", r1.code === 2 && r1.err.includes("报告不可读"));
	const bad = path.join(tmpRoot, "bad-report.json");
	fs.writeFileSync(bad, JSON.stringify({ v: 2, hotspots: [], errorHotspots: [] }));
	const r2 = await runRetropad(["--report", bad, "--state", path.join(tmpRoot, "s.json")], {});
	check("报告形状坏：exit 2 + 原话（v1 hotspots/errorHotspots）", r2.code === 2 && r2.err.includes("报告形状坏"));
}

// ============ 7) 裁决形状坏（交货单到了但无 JSON）：exit 3 ============
{
	const { marker } = freshFixtures("garbage");
	const r = await runRetropad(["--report", reportPath(3), "--state", path.join(tmpRoot, "state-garbage.json")], {
		RETRO_STUB_MODE: "garbage", RETRO_STUB_MARKER: marker, PIANIST_SHELL_URL: "http://127.0.0.1:18781",
	});
	check("裁决形状坏：exit 3 + 无合法 JSON 出声（尾 800 字回显）",
		r.code === 3 && r.err.includes("无合法 JSON 裁决"), r.err.slice(0, 300));
}

// ============ 8) 超时：双时钟收尾 → 讣告 → exit 3（编排器看门真接管） ============
{
	const { marker } = freshFixtures("hang");
	const r = await runRetropad(["--report", reportPath(3), "--state", path.join(tmpRoot, "state-hang.json"), "--timeout", "6"], {
		RETRO_STUB_MODE: "hang", RETRO_STUB_MARKER: marker, PIANIST_SHELL_URL: "http://127.0.0.1:18781",
	});
	check("超时：双时钟 SIGTERM 收尾 → 讣告 → exit 3（v3 三修③：死亡也落账 verdict=failed）",
		r.code === 3 && r.err.includes("分身死亡") && r.err.includes("超时") && /台账：\S+ 状态=死 /.test(r.out),
		JSON.stringify({ code: r.code, out: r.out.split("\n").filter((l) => l.includes("台账")).join("|"), err: r.err.slice(0, 300) }));
	check("超时：死亡落账在场（state verdict=failed failStreak=1——下一场批次减半的依据）",
		(() => { const st = readRetroState(path.join(tmpRoot, "state-hang.json")); return st.source === "json" && st.raw?.verdict === "failed" && st.raw?.failStreak === 1; })(),
		JSON.stringify(readRetroState(path.join(tmpRoot, "state-hang.json")).raw));
}

// ============ 9) 零真钱 + 收尾 ============
{
	// stub 是唯一入口：marker 只在 stub 里落，全部 spawn 物证都出自 stub（真 pi bundle 拉起数=0 由夹具钉死）
	const markers = fs.readdirSync(tmpRoot).filter((f) => f.startsWith("marker-"));
	const spawned = markers.filter((f) => fs.existsSync(path.join(tmpRoot, f)));
	check("零真钱：所有 spawn 物证均出自 stub（ORCH_PI_BIN=stub，真 bundle 0 次）",
		spawned.length >= 3 && process.env.ORCH_PI_BIN === stubPath);
}

mockShell.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
