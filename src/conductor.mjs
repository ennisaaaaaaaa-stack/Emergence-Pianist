#!/usr/bin/env node
// conductor — §三抽卡制地基（2026-09-24）。空闲>30min→等概率抽part→拉起pi session。
// 裁定（洄#752）：独立进程不碰壳；对wake_log只读不写；只做§九环境事件消费层。
// 预算：当日(JST)遥测cost.total之和≥上限→当天硬停。
// 用法：常驻 / --once / --once --dry-run / --status
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
function arg(name, dflt) {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return dflt;
	const v = args[i + 1];
	return v === undefined || v.startsWith("--") ? dflt : v;
}
const ONCE = args.includes("--once");
const DRY = args.includes("--dry-run");
const STATUS = args.includes("--status");
const CWD = path.resolve(import.meta.dirname, "..");
const SHELL_URL = process.env.PIANIST_SHELL_URL ?? "http://127.0.0.1:8770";
const IDLE_MS = Number(arg("idle-min", "30")) * 60_000;
const TICK_MS = Number(arg("tick-sec", "60")) * 1000;
const DAILY_BUDGET = Number(process.env.CONDUCTOR_DAILY_BUDGET ?? arg("daily-budget", "2"));

function todayJST() {
	return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

const STATE_DIR = process.env.CONDUCTOR_STATE_DIR ?? path.join(CWD, "data", "conductor");
const STATE_FILE = path.join(STATE_DIR, "state.json");
function loadState() {
	try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { days: {}, launches: [] }; }
}
function saveState(st) {
	fs.mkdirSync(STATE_DIR, { recursive: true });
	fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 1));
}

// 空闲检测：遥测目录所有文件里最新一条 message_end/tool_use 距 now > IDLE_MS
function lastActivityMs() {
	const dir = process.env.PIANIST_TELEMETRY_DIR ?? path.join(CWD, "data", "telemetry");
	let latest = 0;
	let nFiles = 0;
	let files = [];
	try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return { latest: 0, nFiles: 0 }; }
	for (const f of files) {
		nFiles += 1;
		const lines = fs.readFileSync(path.join(dir, f), "utf8").trim().split(/\r?\n/);
		for (let i = lines.length - 1; i >= 0; i--) {
			let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
			if (ev?.kind !== "message_end" && ev?.kind !== "tool_use") continue;
			const t = Date.parse(ev.ts);
			if (Number.isFinite(t)) { latest = Math.max(latest, t); break; }
		}
	}
	return { latest, nFiles };
}

// part 池可用 CONDUCTOR_PARTS 覆盖（测试/演练用），逗号分隔 id，过滤后仍等概率
const PARTS_ALL = [
	{
		id: "wander",
		desc: "Part3 漫游（纯自主无喂入）",
		prompt: [
			"你是 Emergence Pianist 的漫游分身（wander part）。这是一场纯自主漫游 session：没有任务、没有热点报告、没有期望产出。",
			"你可以做的事：读这个仓库里的遥测和热点报告，看最近的自己们留下什么痕迹；顺着痕迹走（某段重复劳动、某个没走完的 loop、某个反复出现的错误形状）；也可以什么都不查，只写你想写的。",
			"纪律：",
			"1. 单 session 预算内闭环本轮——结尾给一段 200 字以内的收尾笔记（今天走到了哪、值得留下的一句）。",
			"2. 播种纪律：如本轮值得开新线索，收尾下种不超过 1 条 thread，初始 w 封顶 0.5 且标 source=seed。",
			"3. 不读、不引用、不猜测任何用户私人内容——你的视野只有这个仓库。",
		].join("\n"),
	},
	{
		id: "env-event",
		desc: "§九环境事件消费（wake_log 慢通道）",
		// 牌面由 conductor 拉起前注入（events 参数）；队列不可达时降级为空牌面确认跑
		prompt: (events) => [
			"你是 Emergence Pianist 的环境事件分身（env-event part）。慢通道轮到你了：wake_log 里有实时环境唤起在排队，你的任务是消费这一批。",
			"",
			"本轮牌面（conductor 预取，含 thread_id/cosine/信号摘录）：",
			events && events.length
				? events.map((e) => `- #${e.thread_id} cos=${e.cosine} [${e.signal_source}] ${e.signal_text.slice(0, 80).replace(/\n/g, " ")} (${e.logged_at})`).join("\n")
				: "（队列不可达或无新事件——本轮降级为空牌面确认跑，写 100 字以内的收尾笔记即可）",
			"",
			"逐条判断：这条环境信号对琴师们最近的活动有没有实质关联——没有就明说「这条不接」；有关联的，把判断写进收尾笔记（200字以内）。",
			"纪律：只消费不动账——wake_log 你只读不写；单 session 预算内闭环。",
		].join("\n"),
	},
	{
		id: "spoor-session",
		desc: "§八 session spoor（缓建，占位）",
		prompt: [
			"你是 Emergence Pianist 的 session spoor 分身（spoor-session part）。这条产线还在缓建（蓝图 §八准入条件未满），今天这一场是占位确认跑：读 data/ 下遥测与经图现状，写一段 100 字以内的「今天这条产线看见了什么」收尾笔记即可，不做任何写操作。",
		].join("\n"),
	},
];

const PARTS = process.env.CONDUCTOR_PARTS
	? PARTS_ALL.filter((p) => process.env.CONDUCTOR_PARTS.split(",").map((s) => s.trim()).includes(p.id))
	: PARTS_ALL;

// 预算：遥测 message_end 的 cost.total 之和，日历日按 JST 从事件 ts 换算
// （不用文件名过滤——文件名按 UTC 日轮转，JST 晚间的账会躺在前一天的文件里）
function dailySpendYen() {
	const dir = process.env.PIANIST_TELEMETRY_DIR ?? path.join(CWD, "data", "telemetry");
	const today = todayJST();
	let spend = 0;
	let n = 0;
	let files = [];
	try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return { spend: 0, n: 0 }; }
	for (const f of files) {
		for (const line of fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/)) {
			let ev; try { ev = JSON.parse(line); } catch { continue; }
			if (ev?.kind !== "message_end" || !ev.data?.usage) continue;
			const jstDay = new Date(Date.parse(ev.ts) + 9 * 3600_000).toISOString().slice(0, 10);
			if (jstDay !== today) continue;
			n += 1;
			spend += ev.data.usage.cost?.total ?? 0;
		}
	}
	return { spend, n };
}

function drawPart() {
	return PARTS[Math.floor(Math.random() * PARTS.length)];
}

// env-event 牌面预取：svps wake_log 里 replay_day IS NULL 的实时行（未回放消费的）。
// 失败出声降级为空牌面（拉不到队列 ≠ 队列为空）——session 照拉，牌面标明降级原因。
// 消费进度记在 conductor 自己的 state（last_env_event_id），不碰 wake_log（INSERT-only 界约）。
async function fetchEnvEvents(lastId) {
	const SSH = process.env.CONDUCTOR_SVPS_SSH ?? "svps";
	// -json 输出：多行 signal_text 不会被管道分隔符拆断（默认 list 模式会）
	const q = `SELECT id, thread_id, cosine, signal_text, signal_source, logged_at FROM wake_log WHERE replay_day IS NULL AND id > ${Number(lastId) || 0} ORDER BY id DESC LIMIT 5`;
	const { execFile } = await import("node:child_process");
	return new Promise((resolve) => {
		execFile("ssh", [SSH, `sqlite3 -json ~/memory/mcp_memory.db "${q}"`], { timeout: 20_000 }, (err, stdout) => {
			if (err) {
				console.warn(`[conductor] env-event 队列预取失败——空牌面降级（拉不到不等于没有）: ${err.message}`);
				resolve(null); // null=预取失败（降级）；[]=无新事件
			} else {
				const parsed = stdout.trim() ? JSON.parse(stdout) : [];
				const rows = (Array.isArray(parsed) ? parsed : []).map((r) => ({
					id: Number(r.id), thread_id: Number(r.thread_id), cosine: r.cosine,
					signal_text: String(r.signal_text ?? ""), signal_source: r.signal_source, logged_at: r.logged_at,
				}));
				resolve(rows);
			}
		});
	});
}

function launchPart(part) {
	return new Promise((resolve) => {
		const env = {
			...process.env,
			PIANIST_AGENT_ID: `pianist-${part.id}-1`,
			PIANIST_SHELL_URL: SHELL_URL,
			NO_COLOR: "1",
			ZAI_CODING_CN_API_KEY: process.env.ZAI_CODING_CN_API_KEY,
		};
		// CONDUCTOR_PI_BIN：测试/演练时可换 stub（真拉起走默认 pi）
		const piBin = process.env.CONDUCTOR_PI_BIN ?? "./node_modules/.bin/pi";
		const child = spawn(piBin, ["-p", "--model", "zai-coding-cn/glm-5.2", part.prompt], {
			cwd: CWD, env, stdio: ["ignore", "pipe", "pipe"],
		});
		let out = ""; let err = "";
		child.stdout.on("data", (d) => { out += d.toString(); });
		child.stderr.on("data", (d) => { err += d.toString(); });
		child.on("close", (code) => resolve({ code, tail: (out + "\n" + err).slice(-500) }));
	});
}

async function tick() {
	const st = loadState();
	const today = todayJST();
	const day = st.days[today] ?? { draws: 0, launches: 0, spend: 0, budgetHit: false };

	const { spend, n } = dailySpendYen();
	day.spend = spend;
	if (spend >= DAILY_BUDGET) {
		day.budgetHit = true;
		st.days[today] = day;
		saveState(st);
		console.log(`[conductor] 预算硬停：${today} 已烧 ${spend.toFixed(4)}/${DAILY_BUDGET} 元（${n} 场）——当天不再拉`);
		return { acted: false, why: "budget" };
	}

	const { latest, nFiles } = lastActivityMs();
	const idleMs = Date.now() - latest;
	const idleMin = (idleMs / 60000).toFixed(1);
	if (idleMs <= IDLE_MS) {
		console.log(`[conductor] 忙（last=${idleMin}min 前，files=${nFiles}）——不拉`);
		if (!DRY) { st.days[today] = day; saveState(st); }
		return { acted: false, why: "busy" };
	}

	const part = drawPart();
	day.draws += 1;

	// env-event：拉起前预取牌面（失败降级空牌面，session 照拉）
	let prompt = part.prompt;
	let events = null;
	if (part.id === "env-event") {
		events = await fetchEnvEvents(st.last_env_event_id ?? 0);
		prompt = part.prompt(events);
	}
	console.log(`[conductor] 空闲 ${idleMin}min > ${IDLE_MS / 60000}min → 抽卡：${part.id}（${part.desc}）${part.id === "env-event" ? `，牌面 ${events === null ? "预取失败降级" : events.length + " 条"}（>${st.last_env_event_id ?? 0}）` : ""}`);
	if (DRY) {
		console.log(`[conductor] dry-run：不拉起，不记账。今日 draws=${day.draws}`);
		return { acted: false, why: "dry" };
	}

	st.days[today] = day;
	saveState(st);
	console.log(`[conductor] 拉起 ${part.id} ...`);
	const r = await launchPart({ ...part, prompt });
	const maxEventId = events && events.length ? Math.max(...events.map((e) => e.id)) : null;
	st.days[today].launches += 1;
	st.launches.push({ day: today, part: part.id, ts: new Date().toISOString(), exit: r.code, events: maxEventId });
	if (st.launches.length > 200) st.launches.shift();
	// 消费进度推进：只记 conductor 自己的 state，不碰 wake_log（只读界约）
	if (maxEventId !== null) st.last_env_event_id = maxEventId;
	saveState(st);
	if (r.code !== 0) {
		console.error(`[conductor] ${part.id} 非零退出 ${r.code}——尾 300 字：`);
		console.error(r.tail.slice(-300));
	} else {
		console.log(`[conductor] ${part.id} 收工 exit=0`);
	}
	return { acted: true, part: part.id, exit: r.code };
}

async function main() {
	if (STATUS) {
		const st = loadState();
		const today = todayJST();
		const { spend, n } = dailySpendYen();
		console.log(JSON.stringify({
			today, budget: DAILY_BUDGET, spendToday: Number(spend.toFixed(4)), nSessionsToday: n,
			day: st.days[today] ?? null, lastLaunches: (st.launches ?? []).slice(-5),
		}, null, 1));
		return;
	}
	if (ONCE) { await tick(); return; }
	console.log(`[conductor] 常驻启动：idle>${IDLE_MS / 60000}min tick=${TICK_MS / 1000}s budget=${DAILY_BUDGET} 元/日(JST) parts=${PARTS.length}`);
	while (true) {
		try { await tick(); } catch (e) { console.warn(`[conductor] tick 异常（不中断）：${e?.message ?? e}`); }
		await new Promise((r) => setTimeout(r, TICK_MS));
	}
}
main();
