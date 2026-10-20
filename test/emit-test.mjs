// F3 emit 钩子测试（spec：docs/f3-emit-hook-spec-v0.2.md 验收 1-5 全条）。
// 覆盖：①emitEvent 行形状+按日翻篇（注钟跨日）②dispatch.started/exited 真发（直 spawn +
// 沙箱 stub then/catch 三路退场口）③verdict.received 裁决路径 ④watchman.judged /
// escalation.human（conductor --once 真身：任务型停拉链 + 班次型死状）⑤阴性对照（事件账
// 死了不拦主流程 + console.warn 出声；root 下 chmod 不拦写，用「文件当爹目录」真炸 + 注入
// 抛错 fs 双面）⑥架构墙（剥注释后 grep 零命中，机器自证不靠人眼）。
// 纪律：eventsDir 全指 mkdtemp，绝不写真 data/events；conductor pi 全程替身（真钱零花）；
// hearth指死端口（报备失败不拦路径照走，绝不真打真hearth）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra !== undefined && !ok ? " — " + extra : ""}`); }
process.on("exit", (code) => { if (pass !== total) console.error(`[emit-test] exit=${code}——${pass}/${total}（未过面即非零退）`); });

// T16 凭证记账隔离（同 orch-real-driver-test 方子）：RealDriver spawn 走 envOrVault，不隔离会写真柜。
const credTmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-cred-"));
process.env.PORTALK_CRED_DIR = path.join(credTmp, "cred");
process.env.PORTALK_CRED_JOURNAL = path.join(credTmp, "journal.jsonl");
process.env.PIANIST_SHELL_URL = "http://127.0.0.1:1"; // 死端口隔离（缺省 8770 会够得着真壳）
delete process.env.ZAI_CODING_CN_API_KEY;

const CWD = path.resolve(import.meta.dirname, "..");
const { nowJstDay } = await import("../src/orchestrator/day-clock.mjs");
const { emitEvent } = await import("../src/orchestrator/emit.mjs");

/** 读一个事件目录的全部事件行（跨日文件全收——测试不赌午夜边界） */
function readEmitLines(eventsDir) {
	if (!fs.existsSync(eventsDir)) return [];
	const out = [];
	for (const f of fs.readdirSync(eventsDir).filter((x) => /^emit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort()) {
		for (const l of fs.readFileSync(path.join(eventsDir, f), "utf8").split("\n")) {
			const t = l.trim();
			if (!t) continue;
			try { out.push(JSON.parse(t)); } catch { /* 坏行不算账 */ }
		}
	}
	return out;
}

// ---- ①day-clock 纯函数 + emitEvent 行形状/按日翻篇（注钟） ----
{
	check("钟1：JST=UTC+9 日界（14:59:59Z / 15:00:00Z 分属两日）",
		nowJstDay(new Date("2026-10-19T14:59:59.999Z")) === "2026-10-19"
		&& nowJstDay(new Date("2026-10-19T15:00:00.000Z")) === "2026-10-20");
	check("钟2：JST 白天与 UTC 同日；纯函数同输入同输出（含毫秒数入参）",
		nowJstDay(new Date("2026-10-19T03:00:00Z")) === "2026-10-19"
		&& nowJstDay(Date.parse("2026-10-19T03:00:00Z")) === "2026-10-19"
		&& nowJstDay(new Date("2026-10-19T03:00:00Z")) === nowJstDay(new Date("2026-10-19T03:00:00Z")));

	const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "emit-a-"));
	emitEvent("dispatch.started", { minionId: "m1" }, { eventsDir: dirA, now: new Date("2026-10-19T03:00:00Z") });
	emitEvent("dispatch.exited", { minionId: "m1", code: 0 }, { eventsDir: dirA, now: new Date("2026-10-20T03:00:00Z") });
	check("形状1：行形状 { v:1, ts, kind, source:'orchestrator', data }，ts=注钟 ISO",
		(() => {
			const l = readEmitLines(dirA).at(-1);
			return l?.v === 1 && l?.kind === "dispatch.exited" && l?.source === "orchestrator"
				&& l?.ts === "2026-10-20T03:00:00.000Z" && l?.data?.minionId === "m1" && l?.data?.code === 0;
		})(), JSON.stringify(readEmitLines(dirA).at(-1)));
	check("翻篇1：注钟跨日 → 两个日文件各一行，文件名含注钟给的日期（无单文件过渡态）",
		fs.existsSync(path.join(dirA, "emit-2026-10-19.jsonl")) && fs.existsSync(path.join(dirA, "emit-2026-10-20.jsonl"))
		&& fs.readFileSync(path.join(dirA, "emit-2026-10-19.jsonl"), "utf8").trim().split("\n").length === 1
		&& fs.readFileSync(path.join(dirA, "emit-2026-10-20.jsonl"), "utf8").trim().split("\n").length === 1);
}

// ---- ②dispatch.started / dispatch.exited 真发（RealDriver 直 spawn + 沙箱 stub 两路） ----
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-driver-"));
	const evDir = path.join(tmp, "events");
	const stubPi = path.join(tmp, "stub-pi.mjs");
	fs.writeFileSync(stubPi, `console.log("工作完成"); console.log("DONE"); process.exit(0);\n`);
	const { RealDriver } = await import("../src/orchestrator/driver-real.mjs");

	// 直 spawn 路径（sandbox:"无" → tier=null）
	const d1 = new RealDriver({ cwd: tmp, piBin: stubPi, eventsDir: evDir, progressDir: path.join(tmp, "prog") });
	const rec1 = d1.spawn({ taskId: "t-直", minionId: "m-直1", role: "worker pianist", sandbox: "无", prompt: "干活" });
	await d1.rows.get("m-直1").closed; // 退场结算在内部行的 closed（spawn 返回副本不带 Promise）
	// 沙箱路径 then 口（stub 执行器正常结算）
	const d2 = new RealDriver({
		cwd: tmp, piBin: stubPi, eventsDir: evDir, progressDir: path.join(tmp, "prog"),
		runSandboxed: async ({ agent }) => ({ code: 0, signal: null, stdoutTail: `沙箱收工 ${agent}` }),
	});
	const rec2 = d2.spawn({ taskId: "t-沙", minionId: "m-沙1", role: "worker pianist", prompt: "干活" });
	await d2.rows.get("m-沙1").closed;
	// 沙箱路径 catch 口（执行器抛错 → code -1 退场）
	const d3 = new RealDriver({
		cwd: tmp, piBin: stubPi, eventsDir: evDir, progressDir: path.join(tmp, "prog"),
		runSandboxed: async () => { throw new Error("executor 炸了（阴性面）"); },
	});
	const rec3 = d3.spawn({ taskId: "t-沙", minionId: "m-沙2", role: "worker pianist", prompt: "干活" });
	await d3.rows.get("m-沙2").closed;

	const lines = readEmitLines(evDir);
	const started = lines.filter((l) => l.kind === "dispatch.started");
	const exited = lines.filter((l) => l.kind === "dispatch.exited");
	check("driver1：直 spawn → started+exited 各一行，data 带识别键（minionId/taskId/role/code）",
		started.some((l) => l.data?.minionId === "m-直1" && l.data?.taskId === "t-直" && l.data?.role === "worker pianist" && l.data?.sandboxed === false)
		&& exited.some((l) => l.data?.minionId === "m-直1" && l.data?.code === 0 && l.data?.signal === null),
		JSON.stringify(lines));
	check("driver2：沙箱 then 口 → exited code=0（stub 执行器结算路径）",
		exited.some((l) => l.data?.minionId === "m-沙1" && l.data?.code === 0) && started.some((l) => l.data?.minionId === "m-沙1" && l.data?.sandboxed === true),
		JSON.stringify(lines));
	check("driver3：沙箱 catch 口 → exited code=-1（执行器抛错也算收车，不哑火）",
		exited.some((l) => l.data?.minionId === "m-沙2" && l.data?.code === -1),
		JSON.stringify(lines));
	check("driver4：台账行为零回归（三个分身全收车、死状形状不变）",
		d1.get("m-直1").exit.code === 0 && d2.get("m-沙1").exit.code === 0 && d3.get("m-沙2").exit.code === -1);
}

// ---- ③verdict.received 裁决路径（buildRuntime 审链 VERDICT 分支） ----
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-verdict-"));
	const evDir = path.join(dir, "events");
	const fakePi = path.join(dir, "fake-pi.mjs");
	fs.writeFileSync(fakePi, `
const prompt = process.argv[process.argv.length - 1] ?? "";
if (prompt.includes("审链任务")) { console.log("红项1：出图为空。"); console.log("VERDICT:fail"); }
else { console.log("DONE fake-delivery"); }
`);
	process.env.PIANIST_SESSIONS_DIR = path.join(dir, "sessions");
	const { buildRuntime } = await import("../src/orchestrator/runtime.mjs");
	const rt = buildRuntime({
		sheetText: `
任务：审链VERDICT心跳

角色表：
  - 角色:worker pianist | 数量:1 | 沙箱:无 | 审链:评审员
  - 角色:评审员 | 数量:1 | 沙箱:无

预算袋：时长 10 分钟

交付物清单：
- out/final.png

验收标准：
- 出图非空
`,
		piBin: fakePi,
		eventsDir: evDir,
		progressDir: path.join(dir, "prog"),
		telemetryDir: path.join(dir, "tel"),
		watchman: false,
		pollApprovals: false,
		supervisorCfg: { timeoutMs: 60_000 },
	});
	rt.launchMinion({ taskId: "v-emit", role: "worker pianist" });
	const t0 = Date.now();
	let vLine = null;
	while (Date.now() - t0 < 15_000) {
		vLine = readEmitLines(evDir).find((l) => l.kind === "verdict.received") ?? null;
		if (vLine) break;
		await new Promise((r) => setTimeout(r, 100));
	}
	check("裁决1：verdict.received 在裁决路径发（minionId=审链分身、taskId、verdict=fail）",
		vLine?.data?.minionId?.includes("-审-") === true && vLine?.data?.taskId === "v-emit" && vLine?.data?.verdict === "fail",
		JSON.stringify(vLine));
	check("裁决2：同一路径 dispatch.started/exited 也在（审链分身也发车）",
		readEmitLines(evDir).some((l) => l.kind === "dispatch.started" && l.data?.minionId === vLine?.data?.minionId));
	rt.stop?.();
}

// ---- ④watchman.judged / escalation.human（conductor --once 真身两场景） ----
{
	// 密封底：ambient CONDUCTOR_*/HEARTH_URL/ORCH_* 剥净起底（同 watchman-test 方子）
	const CLEAN_ENV = { ...process.env };
	for (const k of Object.keys(CLEAN_ENV)) if (/^CONDUCTOR_/.test(k)) delete CLEAN_ENV[k];
	delete CLEAN_ENV.HEARTH_URL;
	delete CLEAN_ENV.ORCH_EVENTS_DIR;

	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "emit-watchman-"));
	const telDir = path.join(tmp, "telemetry");
	fs.mkdirSync(telDir, { recursive: true });
	const hotspotOut = path.join(tmp, "hotspots", "latest.json");
	fs.mkdirSync(path.dirname(hotspotOut), { recursive: true });
	fs.writeFileSync(hotspotOut, JSON.stringify({ v: 1, generatedAt: new Date().toISOString(), hotspots: [], errorHotspots: [] }));
	const retroStateFile = path.join(tmp, "retro", "state.json");
	fs.mkdirSync(path.dirname(retroStateFile), { recursive: true });
	fs.writeFileSync(retroStateFile, JSON.stringify({ v: 1, lastRetroAt: new Date().toISOString(), runs: 1 })); // 冷却窗内：retro 心跳安静
	const piStub = path.join(tmp, "pi-stub.mjs");
	fs.writeFileSync(piStub, [
		'import fs from "node:fs";',
		'fs.appendFileSync(process.env.PI_STUB_LOG, JSON.stringify({ pid: process.pid, exit: Number(process.env.PI_STUB_EXIT ?? 0) }) + "\\n");',
		"process.exit(Number(process.env.PI_STUB_EXIT ?? 0));",
	].join("\n"));

	function mkScenario(name, entries) {
		const dir = path.join(tmp, name);
		const stateDir = path.join(dir, "state");
		fs.mkdirSync(stateDir, { recursive: true });
		fs.mkdirSync(path.join(dir, "stig"), { recursive: true });
		const schedFile = path.join(dir, "schedule.json");
		fs.writeFileSync(schedFile, JSON.stringify({ v: 1, default_permission: "always-ask", entries }, null, 2));
		const evDir = path.join(dir, "events");
		return {
			evDir,
			once: (extra = {}) => spawnSync(process.execPath, [path.join(CWD, "src", "conductor.mjs"), "--once"], {
				env: {
					...CLEAN_ENV,
					CONDUCTOR_PARTS: "wander",
					CONDUCTOR_IDLE_NOW: "1",
					CONDUCTOR_STATE_DIR: stateDir,
					PIANIST_TELEMETRY_DIR: telDir,
					CONDUCTOR_HOTSPOT_OUT: hotspotOut,
					CONDUCTOR_HOTSPOT_DIR: path.join(tmp, "no-such-dir"),
					CONDUCTOR_RETRO_STATE: retroStateFile,
					CONDUCTOR_PI_BIN: piStub,
					CONDUCTOR_SCHEDULE_FILE: schedFile,
					CONDUCTOR_ACTIVE_HOURS: "00:00-24:00",
					CONDUCTOR_STIGMERGY_ROOT: path.join(dir, "stig"),
					CONDUCTOR_DAILY_BUDGET: "999",
					HEARTH_URL: "http://127.0.0.1:1", // 死端口：报备失败不拦停拉路径（绝不真打真hearth）
					PIANIST_SHELL_URL: "http://127.0.0.1:1",
					PI_STUB_LOG: path.join(dir, "pi.log"),
					ORCH_EVENTS_DIR: evDir,
					...extra.env,
				},
				encoding: "utf8", timeout: 120_000,
			}),
		};
	}
	const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
	const MIN = 60_000;
	const dueEntry = (id) => ({ id, window: { start: iso(30 * MIN), end: iso(-60 * MIN) }, part: "wander", intent: "emit 测试", created_by: "test", status: "approved" });

	// 场一（任务型停拉链）：due 条目 ×4 连死 → relaunch×3 后 stop-human → judged×4 + escalation×1
	{
		const sc = mkScenario("crash-chain", [dueEntry("t5")]);
		const r = sc.once({ env: { PI_STUB_EXIT: "1" } });
		const outAll = `${r.stdout}\n${r.stderr}`;
		const lines = readEmitLines(sc.evDir);
		const judged = lines.filter((l) => l.kind === "watchman.judged");
		const escal = lines.filter((l) => l.kind === "escalation.human");
		check("更夫1：任务型判定心跳真发（sched:t5 四连判，末条 stop-human，data 带 verdict/attempt）",
			r.status === 0 && judged.filter((l) => l.data?.task === "sched:t5").length === 4
			&& judged.at(-1)?.data?.verdict === "stop-human" && judged.every((l) => typeof l.data?.attempt === "number"),
			`status=${r.status} judged=${JSON.stringify(judged.map((l) => l.data?.verdict))} tail=${outAll.slice(-300)}`);
		check("更夫2：escalation.human 在停拉转人类路径发（schedId=t5，reason/attempt 在场）",
			escal.length === 1 && escal[0]?.data?.schedId === "t5" && typeof escal[0]?.data?.attempt === "number" && !!escal[0]?.data?.reason,
			JSON.stringify(escal));
	}
	// 场二（班次型死状）：无 schedule，抽卡 wander ×pi 死 → judged part:wander log-only（无报备无 escalation）
	{
		const sc = mkScenario("shift-death", []);
		const r = sc.once({ env: { PI_STUB_EXIT: "1" } });
		const lines = readEmitLines(sc.evDir);
		const judged = lines.filter((l) => l.kind === "watchman.judged");
		const escal = lines.filter((l) => l.kind === "escalation.human");
		check("更夫3：班次型判定心跳真发（part:wander log-only，不出 escalation）",
			r.status === 0 && judged.length === 1 && judged[0]?.data?.task === "part:wander" && judged[0]?.data?.verdict === "log-only"
			&& judged[0]?.data?.partId === "wander" && escal.length === 0,
			`status=${r.status} judged=${JSON.stringify(judged)} escal=${escal.length}`);
	}
}

// ---- ⑤阴性对照：事件账死了不拦主流程 + warn 出声（root 下 chmod 不拦写——用文件当爹目录真炸 + 注入抛错 fs 双面） ----
{
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "emit-neg-"));
	const warns = [];
	const origWarn = console.warn;
	console.warn = (...a) => { warns.push(a.join(" ")); };
	try {
		const blocker = path.join(dir, "blocker");
		fs.writeFileSync(blocker, "x");
		emitEvent("dispatch.started", { minionId: "neg1" }, { eventsDir: path.join(blocker, "sub") }); // mkdirSync ENOTDIR（root 也拦）
		const boomFs = { mkdirSync: () => { throw new Error("注入炸（阴性面）"); }, appendFileSync: () => { throw new Error("注入炸（阴性面）"); } };
		emitEvent("dispatch.exited", { minionId: "neg1" }, { eventsDir: dir, fs: boomFs });
	} finally {
		console.warn = origWarn;
	}
	check("阴1：两次写失败都没抛（主流程照跑——若抛了本 check 根本到不了）", true);
	check("阴2：warn 出声两次且带「不拦主流程」与 kind",
		warns.length === 2 && warns.every((w) => w.includes("不拦主流程") && w.includes("kind=dispatch.")),
		JSON.stringify(warns));
}

// ---- ⑥架构墙：emit.mjs 剥注释后 grep 零命中（机器自证，不靠人眼） ----
{
	const strip = (src) => src
		.replace(/\/\*[\s\S]*?\*\//g, "")   // 块注释整段剥
		.split("\n")
		.map((l) => l.replace(/\/\/.*$/, "")) // 行注释尾剥
		.join("\n");
	const WALL = /hermes|session/i;
	const src = fs.readFileSync(path.join(CWD, "src", "orchestrator", "emit.mjs"), "utf8");
	check("墙1：剥法自证（注释里的词被剥净、代码里的词照命中——剥法失灵时本面先红）",
		!WALL.test(strip("// hermes 词在行注释\n/* session 词在块注释 */\nconst a = 1;"))
		&& WALL.test(strip("const s = \"hermes\";")));
	check("墙2：emit.mjs 剥注释后零命中（被禁词连注释都不进文件）",
		!WALL.test(strip(src)), (src.match(WALL) ?? ["(剥后无，剥前有)"])[0]);
}

console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
