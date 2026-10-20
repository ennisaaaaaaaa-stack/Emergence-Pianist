// F1 更夫重拉验收测试（2026-10-18 f1-watchman 施工单，spec：docs/f1-watchman-spec-v0.1.md）。
// 覆盖 spec「验收」节 1-9 全条（含 8b 反查新鲜度护栏阴性对照、8c 报备失败不拦路）：
//   1 拔插头（模块缺失/抛错 → conductor 照跑）  2 exit=0 永不重拉  3 parent-down 不计数
//   4 三尸停拉（4th 死 stop-human 无新行）        5 突变 MAX=2      6 断电孤儿（任务 heal/班次 log-only）
//   7 判据行格式（console 行形状，不翻源码）      8 fired-无行缝（log-only+hearth报备+幂等+班次无报备）
//   8b fired_at>24h 无判定无报备                  8c hearth死端口不拦路
//   9 heal 上限（4th 环境死停拉）+ 孤儿 24h 新鲜度（隔夜首验即待审·人）
// 测法：纯函数面直测 evaluateWatchman/recordWatchmanDeath/判据行/三件套；接线面真跑 conductor
// --once（判定/台账/验尸/报备全真身），pi 全程替身（真钱零花是本单铁律），hearth用本地 stub
// http server（绝不真打 172.26.176.1——HEARTH_URL 每场景显式指面）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import net from "node:net";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import {
	evaluateWatchman, recordWatchmanDeath, watchmanJudgeLine, watchmanRelaunchPrefix,
	classifyDeathLaunch, slideWatchmanLedger, WATCHMAN_VERDICTS, WATCHMAN_WINDOW_MS,
} from "../src/watchman.mjs";

// T16 凭证记账隔离（同 conductor-retro-wire-test 方子）：spawn conductor 真身的测试不隔离
// PORTALK_CRED_*，envOrVault 会写真柜/真账本。双覆盖到 tmp——真钱审计零新增的根。
const __credTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pianist-cred-seal-"));
process.env.PORTALK_CRED_DIR = path.join(__credTmp, "cred");
process.env.PORTALK_CRED_JOURNAL = path.join(__credTmp, "journal.jsonl");

const CWD = path.resolve(import.meta.dirname, "..");
const CONDUCTOR = path.join(CWD, "src", "conductor.mjs");
let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); }

// 收尸双钩：uncaughtException 不许静默吞（红面要有声），exit 钩对账（过面数与退出码一致）
process.on("uncaughtException", (e) => { console.error(`[test] uncaughtException（收尸钩）：${e?.stack ?? e}`); process.exit(1); });
process.on("exit", (code) => { if (code !== 0) console.error(`[test] exit=${code}——${pass}/${total}（未过面即非零退）`); });

// 密封底（同款方子）：ambient CONDUCTOR_*/HEARTH_URL 剥净起底 + 头顶灌假 ambient 自证
Object.assign(process.env, { CONDUCTOR_EVENT_TABLE: "ambient-seal-probe-not-real", CONDUCTOR_DAILY_BUDGET: "77", CONDUCTOR_WATCHMAN_MAX: "9", HEARTH_URL: "http://ambient-seal-hearth-not-real:1" });
const CLEAN_ENV = { ...process.env };
for (const k of Object.keys(CLEAN_ENV)) if (/^CONDUCTOR_/.test(k)) delete CLEAN_ENV[k];
delete CLEAN_ENV.HEARTH_URL;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "watchman-f1-"));
const telDir = path.join(tmp, "telemetry");
fs.mkdirSync(telDir, { recursive: true });
const SHELL_URL = `http://127.0.0.1:${20000 + Math.floor(Math.random() * 20000)}`;
fs.writeFileSync(path.join(telDir, "pianist-wander-1.jsonl"), [
	JSON.stringify({ v: 1, ts: new Date().toISOString(), agent: "pianist-wander-1", kind: "message_end", data: { usage: { totalTokens: 10, cost: { total: 0.001 } } } }),
	"",
].join("\n"));
const hotspotOut = path.join(tmp, "hotspots", "latest.json");
fs.mkdirSync(path.dirname(hotspotOut), { recursive: true });
fs.writeFileSync(hotspotOut, JSON.stringify({ v: 1, generatedAt: new Date().toISOString(), hotspots: [], errorHotspots: [] }));
const retroStateFile = path.join(tmp, "retro", "state.json");
fs.mkdirSync(path.dirname(retroStateFile), { recursive: true });
fs.writeFileSync(retroStateFile, JSON.stringify({ v: 1, lastRetroAt: new Date().toISOString(), runs: 1 })); // 冷却窗内：retro 心跳安静

// hearth stub（独立进程）：spawnSync 会冻住本进程事件循环——同进程 http server 接不了被测
// conductor 的连接（实测 5s 全挂到 abort）。stub 独立进程记账到文件，断言读文件（绝不真打真hearth）。
const hearthLog = path.join(tmp, "hearth-stub.log");
const hearthStub = path.join(tmp, "hearth-stub.mjs");
fs.writeFileSync(hearthStub, [
	'import http from "node:http";',
	'import fs from "node:fs";',
	'const [port, log] = process.argv.slice(2);',
	'http.createServer((req, resp) => {',
	'	let b = "";',
	'	req.on("data", (c) => { b += c; });',
	'	req.on("end", () => {',
	'		let body = b; try { body = JSON.parse(b); } catch { /* 保原文 */ }',
	'		fs.appendFileSync(log, JSON.stringify({ path: req.url, body }) + "\\n");',
	'		resp.writeHead(200, { "content-type": "application/json" });',
	'		resp.end(String.raw`{"ok":true}`);',
	'	});',
	'}).listen(Number(port), "127.0.0.1");',
].join("\n"));
const hearthPort = await new Promise((res) => {
	const s = net.createServer();
	s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); });
});
const hearthProc = spawn(process.execPath, [hearthStub, String(hearthPort), hearthLog], { stdio: "ignore" });
const HEARTH_STUB = `http://127.0.0.1:${hearthPort}`;
for (let i = 0; i < 50; i++) { // 就绪探针：TCP 能连即收
	const ok = await new Promise((res) => {
		const s = net.connect(hearthPort, "127.0.0.1");
		s.on("connect", () => { s.destroy(); res(true); });
		s.on("error", () => res(false));
	});
	if (ok) break;
	await new Promise((r) => setTimeout(r, 100));
}
const hearthPosts = () => (fs.existsSync(hearthLog) ? fs.readFileSync(hearthLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const hearthReset = () => { fs.writeFileSync(hearthLog, ""); };

// pi 替身：argv 全量记账 + 退出码走 PI_STUB_EXIT（crash 链/heal 链/健康面共用一个替身）
const piStub = path.join(tmp, "pi-stub.mjs");
fs.writeFileSync(piStub, [
	'import fs from "node:fs";',
	'fs.appendFileSync(process.env.PI_STUB_LOG, JSON.stringify({ pid: process.pid, exit: Number(process.env.PI_STUB_EXIT ?? 0), argv: process.argv.slice(2) }) + "\\n");',
	"process.exit(Number(process.env.PI_STUB_EXIT ?? 0));",
].join("\n"));

// 更夫拔插头桩①：不存在的模块（import 报错面）；桩②：顶层 throw（模块抛错面）
const watchmanMissing = path.join(tmp, "no-such-watchman.mjs");
const watchmanBoom = path.join(tmp, "watchman-boom.mjs");
fs.writeFileSync(watchmanBoom, 'throw new Error("watchman-boom（拔插头验收面：模块顶层抛错）");\n');

// 断电孤儿 pid：挑一个 /proc 里不存在的（进程已不在的实证面）
let deadPid = 999_000;
while (fs.existsSync(`/proc/${deadPid}`)) deadPid += 1;

const H = 3600_000, MIN = 60_000;
const iso = (msAgo) => new Date(Date.now() - msAgo).toISOString();
const localDay = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
const judgeLines = (s) => s.match(/^\[conductor\] 更夫判定：.*$/gm) ?? [];
const JUDGE_RE = /^\[conductor\] 更夫判定：task=(sched:\S+|part:\S+) verdict=(relaunch|heal|stop-human|log-only|done) reason=.+ attempt=\d+\/\d+$/;
const parsed = (lines) => lines.map((l) => {
	const m = l.match(/task=(\S+) verdict=(\S+) .*attempt=(\d+)\/(\d+)$/);
	return m ? { task: m[1], verdict: m[2], attempt: `${m[3]}/${m[4]}` } : null;
});
const dueEntry = (id) => ({ id, window: { start: iso(30 * MIN), end: iso(-60 * MIN) }, part: "wander", intent: "F1 验收", created_by: "test", status: "approved" });
const firedEntry = (id, firedAgoMs) => ({ id, window: { start: iso(26 * H), end: iso(-1 * H) }, part: "wander", intent: "F1 缝", created_by: "test", status: "fired", fired_at: iso(firedAgoMs) });
const journalText = (stig) => { try { return fs.readFileSync(path.join(stig, "workbench", "portalk", "journal", `${localDay()}.md`), "utf8"); } catch { return ""; } };
const out = (r) => `${r.stdout}\n${r.stderr}`; // console.warn 落 stderr——出声断言用合并面

// 每场景独立 state/schedule/stig（夹具互不串台）；once() 真跑 conductor（判定/台账/报备全真身）
function mk(name) {
	const dir = path.join(tmp, name);
	const stateDir = path.join(dir, "state");
	const stig = path.join(dir, "stig");
	fs.mkdirSync(stateDir, { recursive: true });
	fs.mkdirSync(stig, { recursive: true });
	const schedFile = path.join(dir, "schedule.json");
	fs.writeFileSync(schedFile, JSON.stringify({ v: 1, default_permission: "always-ask", entries: [] }, null, 2));
	return {
		dir, stateDir, stateFile: path.join(stateDir, "state.json"), stig, schedFile,
		writeState: (st) => fs.writeFileSync(path.join(stateDir, "state.json"), JSON.stringify(st)),
		readState: () => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8")); } catch { return { days: {}, launches: [] }; } },
		writeSched: (entries) => fs.writeFileSync(schedFile, JSON.stringify({ v: 1, default_permission: "always-ask", entries }, null, 2)),
		once: (extra = {}) => spawnSync(process.execPath, [CONDUCTOR, ...(extra.args ?? ["--once"])], {
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
				CONDUCTOR_STIGMERGY_ROOT: stig,
				CONDUCTOR_DAILY_BUDGET: "999",
				HEARTH_URL: HEARTH_STUB,
				PIANIST_SHELL_URL: SHELL_URL,
				PI_STUB_LOG: path.join(dir, "pi.log"),
				...extra.env,
			},
			encoding: "utf8", timeout: 120_000,
		}),
		marks: () => (fs.existsSync(path.join(dir, "pi.log")) ? fs.readFileSync(path.join(dir, "pi.log"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
	};
}

// ---- 纯函数面（spec ①②③④⑤ 的机械判定，零 IO 直测）----
{
	const NOW = Date.now();
	const ev = (p) => evaluateWatchman({ ...p, now: NOW });
	check("纯1（验收2钉死）：exit=0 任何 prior/上限下 → done 永不重拉",
		ev({ deadLaunch: { exit: 0 }, prior: { count: 3, firstTs: NOW - MIN }, isTaskLike: true }).verdict === "done"
		&& classifyDeathLaunch({ exit: 0 }).kind === "done");
	check("纯2：任务型 crash（exit=1 无 signal）→ relaunch attempt=1",
		ev({ deadLaunch: { exit: 1 }, prior: undefined, isTaskLike: true }).verdict === "relaunch"
		&& ev({ deadLaunch: { exit: 1 }, isTaskLike: true }).attempt === 1);
	check("纯3：任务型 killed（signal=SIGKILL）→ relaunch（非确定性死照拉）",
		ev({ deadLaunch: { exit: null, signal: "SIGKILL" }, isTaskLike: true }).verdict === "relaunch");
	check("纯4：班次型任何死状 → log-only attempt=0 不计数",
		ev({ deadLaunch: { exit: 1 }, isTaskLike: false }).verdict === "log-only" && ev({ deadLaunch: { exit: 1 }, isTaskLike: false }).attempt === 0
		&& ev({ deadLaunch: { exit: null, signal: "SIGTERM" }, isTaskLike: false }).verdict === "log-only");
	check("纯5（验收3）：parent-down → heal，attempt 不动",
		ev({ deadLaunch: { exit: null, signal: "parent-down" }, prior: { count: 0 }, isTaskLike: true }).verdict === "heal"
		&& ev({ deadLaunch: { exit: null, signal: "parent-down" }, isTaskLike: true }).attempt === 0);
	check("纯6：断电孤儿（无 exit 无 signal，行龄新鲜）→ heal",
		ev({ deadLaunch: { ts: iso(5 * MIN) }, isTaskLike: true }).verdict === "heal" && classifyDeathLaunch({}).kind === "orphan");
	check("纯7（验收9后半）：孤儿行龄 >24h → stop-human（隔夜半成品转待审·人不补）",
		ev({ deadLaunch: { ts: iso(25 * H) }, isTaskLike: true }).verdict === "stop-human"
		&& ev({ deadLaunch: { ts: iso(25 * H) }, isTaskLike: true }).reason.includes("待审·人"));
	check("纯8（验收4判据）：prior count=3（=上限）→ 第 4 次 crash 死 stop-human",
		ev({ deadLaunch: { exit: 1 }, prior: { count: 3, firstTs: NOW - MIN }, isTaskLike: true }).verdict === "stop-human");
	check("纯9（验收9判据）：healCount=3 已满 → 第 4 次环境死 stop-human（crash 账不动）",
		ev({ deadLaunch: { exit: null, signal: "parent-down" }, prior: { healCount: 3, healFirstTs: NOW - MIN }, isTaskLike: true }).verdict === "stop-human");
	check("纯10（spec④滑动窗）：firstTs 出 24h 窗 → 计数清零重起算（新的一天新的三次机会）",
		ev({ deadLaunch: { exit: 1 }, prior: { count: 2, firstTs: NOW - 25 * H }, isTaskLike: true }).verdict === "relaunch"
		&& ev({ deadLaunch: { exit: 1 }, prior: { count: 2, firstTs: NOW - 25 * H }, isTaskLike: true }).attempt === 1);
	check("纯11：healFirstTs 出窗 → healCount 清零（环境病好了该让跑）",
		ev({ deadLaunch: { exit: null, signal: "parent-down" }, prior: { healCount: 2, healFirstTs: NOW - 25 * H }, isTaskLike: true }).verdict === "heal");
	check("纯12（验收5判据）：max 注入真在读——max=2 时 count=2 即停、count=1 还拉 attempt=2",
		ev({ deadLaunch: { exit: 1 }, prior: { count: 2, firstTs: NOW - MIN }, isTaskLike: true, max: 2 }).verdict === "stop-human"
		&& ev({ deadLaunch: { exit: 1 }, prior: { count: 1, firstTs: NOW - MIN }, isTaskLike: true, max: 2 }).attempt === 2);
	const rec1 = recordWatchmanDeath(undefined, { exit: 1, tail: "x".repeat(600) }, "relaunch", NOW);
	const rec2 = recordWatchmanDeath(rec1, { exit: 1 }, "relaunch", NOW + MIN);
	check("纯13（spec④台账）：relaunch 落账 count+1、history 带 tail300 截断、firstTs/lastTs 在场",
		rec2.count === 2 && rec2.history.length === 2 && rec2.history[0].tail300.length === 300
		&& Number.isFinite(rec2.firstTs) && Number.isFinite(rec2.lastTs));
	const h1 = recordWatchmanDeath(undefined, { exit: null, signal: "parent-down" }, "heal", NOW);
	const h2 = recordWatchmanDeath(h1, { exit: null, signal: "parent-down" }, "heal", NOW + MIN);
	check("纯14（验收3台账）：连续两次 parent-down 补拉后 count 仍为 0、healCount=2（机器的错不进 session 的账）",
		h2.count === 0 && h2.healCount === 2 && h2.history.every((x) => x.heal === true));
	check("纯15（验收7）：判据行格式钉死（task= 侧 task/part 分叉 + verdict 枚举 + attempt=N/M）",
		watchmanJudgeLine({ sched: "t1", verdict: "relaunch", reason: "r", attempt: 2 }) === "[conductor] 更夫判定：task=sched:t1 verdict=relaunch reason=r attempt=2/3"
		&& watchmanJudgeLine({ part: "wander", verdict: "log-only", reason: "r", attempt: 0, max: 2 }) === "[conductor] 更夫判定：task=part:wander verdict=log-only reason=r attempt=0/2"
		&& WATCHMAN_VERDICTS.join(",") === "relaunch,heal,stop-human,log-only,done"
		&& WATCHMAN_VERDICTS.every((v) => JUDGE_RE.test(watchmanJudgeLine({ sched: "x", verdict: v, reason: " Reasons 带 空格 也 单行", attempt: 1 }))));
	const ts16 = iso(3 * MIN); // 单次求值：夹具与期望串共用同一字符串（两次 iso() 跨毫秒边界会闪断 includes）
	const pre = watchmanRelaunchPrefix({ nth: 2, deadLaunch: { exit: 1, ts: ts16, ms: 4500, tail: "尾部输出", events: 42 } });
	check("纯16（spec③三件套）：标题+死因+死前进度（ts/ms/游标）+A3 接着干四件齐",
		pre.includes("【更夫重拉·第 2 次尝试】") && pre.includes("- 死因：exit code=1") && pre.includes("尾 300 字：尾部输出")
		&& pre.includes(`- 死前进度：上次拉起 ${ts16}，运行 4500ms，事件游标 42`)
		&& pre.includes("接着干，不从头来（A3 spool 语义）"));
	check("纯17：heal 补拉标题分叉（attempt 不计说在脸上）+ 死行无尾/无游标的降级形状不炸",
		watchmanRelaunchPrefix({ nth: 1, kind: "heal", deadLaunch: { signal: "parent-down" } }).includes("【更夫补拉·环境死第 1 次")
		&& watchmanRelaunchPrefix({ nth: 1, deadLaunch: {} }).includes("（无输出尾）") && watchmanRelaunchPrefix({ nth: 1, deadLaunch: {} }).includes("事件游标 无"));
	check("纯18：坏形状输入不炸（null 行/null prior/垃圾 max 各自回落不抛）",
		(() => { try { return ev({ deadLaunch: null, isTaskLike: true }).verdict && ev({ deadLaunch: { exit: 1 }, prior: "垃圾", isTaskLike: true }).verdict === "relaunch" && evaluateWatchman({ deadLaunch: { exit: 1 }, isTaskLike: true, max: "垃圾" }).attempt === 1; } catch { return false; } })()
		&& slideWatchmanLedger(null, NOW).count === 0);
}

// ---- 场A（验收1 拔插头）：watchman 模块缺失/抛错 → conductor tick 照跑 ----
{
	const sc = mk("a-unplug");
	sc.writeSched([firedEntry("t8", 1 * H)]); // 缝条目在场：拔了更夫也不许出判定行（静默缺席）
	const r1 = sc.once({ env: { CONDUCTOR_WATCHMAN_MODULE: watchmanMissing } });
	check("场A1（验收1）：模块缺失 → conductor 照跑（exit 0 + 抽卡照走 + 无判定行 + warn 出声）",
		r1.status === 0 && r1.stdout.includes("抽卡：wander") && judgeLines(r1.stdout).length === 0 && out(r1).includes("更夫模块不可用"),
		(out(r1).match(/更夫模块不可用[^\n]*/) || ["(无 warn)"])[0].slice(0, 120));
	const r2 = sc.once({ env: { CONDUCTOR_WATCHMAN_MODULE: watchmanBoom } });
	check("场A2（验收1）：模块顶层抛错 → 同款拔插头（tick 不因更夫死而死）",
		r2.status === 0 && judgeLines(r2.stdout).length === 0 && out(r2).includes("更夫模块不可用"));
}

// ---- 场B（验收2 接线面）：健康 fire（exit=0）不进更夫——无判定行无台账无 relaunch ----
{
	const sc = mk("b-done");
	sc.writeSched([dueEntry("t5")]);
	const r = sc.once();
	const st = sc.readState();
	const schedRows = (st.launches ?? []).filter((l) => l.sched === "t5");
	check("场B1（验收2）：干完死 exit=0 → 无更夫判定行、行恰 1 条 exit=0",
		r.status === 0 && judgeLines(r.stdout).length === 0 && schedRows.length === 1 && schedRows[0].exit === 0
		&& !schedRows[0].relaunch_of && !("watchman" in st), `rows=${JSON.stringify(schedRows)}`);
}

// ---- 场C（验收4+7+停拉转人类）：三尸停拉——4 次死=relaunch×3 后 stop-human，无第 5 行 ----
{
	const sc = mk("c-three-crash");
	sc.writeSched([dueEntry("t5")]);
	hearthReset();
	const r = sc.once({ env: { PI_STUB_EXIT: "1" } });
	const lines = judgeLines(r.stdout);
	const pj = parsed(lines);
	check("场C1（验收7）：全部判定行形状合法（console 行断言，不翻源码）",
		lines.length > 0 && lines.every((l) => JUDGE_RE.test(l)), lines[0] ?? "(无判定行)");
	check("场C2（验收4）：4 连死 → relaunch×3（attempt 1/3→2/3→3/3）后第 4 次 stop-human",
		pj.length === 4 && pj[0].verdict === "relaunch" && pj[0].attempt === "1/3" && pj[1].attempt === "2/3" && pj[2].attempt === "3/3"
		&& pj[3].verdict === "stop-human" && pj.every((x) => x.task === "sched:t5"), JSON.stringify(pj));
	const st = sc.readState();
	const rows = st.launches.filter((l) => l.sched === "t5");
	check("场C3（验收4）：无新 launch 行——恰 4 行（原行+3 重拉），relaunch_of 链逐行回指",
		rows.length === 4 && rows.slice(1).every((row, i) => row.relaunch_of === rows[i].ts) && rows[0].relaunch_of === undefined,
		`rows=${rows.length}`);
	check("场C4（spec④台账）：count=3、history 3 条带 exit/tail300；先写后做（行序=判序）",
		st.watchman?.relaunches?.t5?.count === 3 && st.watchman.relaunches.t5.history.length === 3
		&& st.watchman.relaunches.t5.history.every((h) => h.exit === 1 && typeof h.tail300 === "string"));
	const relaunchPrompts = sc.marks().map((m) => String(m.argv.at(-1))).filter((p) => p.includes("更夫重拉"));
	check("场C5（spec③三件套）：3 次重拉 prompt 各带三件套前缀（死因/死前进度/接着干）",
		relaunchPrompts.length === 3 && relaunchPrompts.every((p) => p.includes("【更夫重拉·第 1 次尝试】") || p.includes("第 2 次尝试") || p.includes("第 3 次尝试"))
		&& relaunchPrompts[0].includes("- 死因：exit code=1") && relaunchPrompts[0].includes("死前进度") && relaunchPrompts[0].includes("A3 spool 语义"),
		`prompts=${relaunchPrompts.length}`);
	check("场C6（spec⑥转法）：stop-human hearth报备恰一条（sender=conductor/大厅，带死因+重拉史+建议动作）",
		(() => { const posts = hearthPosts(); return posts.length === 1 && posts[0]?.path === "/api/send" && posts[0]?.body?.sender === "conductor"
		&& posts[0]?.body?.room === "大厅" && /停拉转人类/.test(posts[0]?.body?.text ?? "") && /#t5/.test(posts[0]?.body?.text ?? "")
		&& /重拉史/.test(posts[0]?.body?.text ?? ""); })(),
		JSON.stringify(hearthPosts().map((p) => p.body?.text?.slice(0, 40))));
	const jt = journalText(sc.stig);
	check("场C7（spec⑥转法）：spoor journal 落「待审·人」（(conductor) 署名 + sched id + 建议动作）",
		jt.includes("- **[待审·人]** (conductor)") && jt.includes("#t5") && jt.includes("待审"), jt.slice(0, 80) || "(无 journal)");
}

// ---- 场D（验收5 突变）：CONDUCTOR_WATCHMAN_MAX=2 → 第 3 次死即停（上限真在读不是写死）----
{
	const sc = mk("d-mutate-max2");
	sc.writeSched([dueEntry("t5")]);
	const r = sc.once({ env: { PI_STUB_EXIT: "1", CONDUCTOR_WATCHMAN_MAX: "2" } });
	const pj = parsed(judgeLines(r.stdout));
	const rows = sc.readState().launches.filter((l) => l.sched === "t5");
	check("场D1（验收5）：MAX=2 → relaunch 1/2、2/2 后第 3 次死 stop-human（attempt=N/2 面）",
		pj.length === 3 && pj[0].attempt === "1/2" && pj[1].attempt === "2/2" && pj[2].verdict === "stop-human" && pj[2].attempt === "2/2",
		JSON.stringify(pj));
	check("场D2（验收5）：停在第 3 行（原行+2 重拉），无第 4 行", rows.length === 3, `rows=${rows.length}`);
}

// ---- 场E（验收6）：断电孤儿首 tick 验尸——任务型 heal、班次型 log-only；幂等不重验 ----
{
	const sc = mk("e-orphan");
	const orphanTaskTs = iso(5 * MIN); // 夹具行 ts（断言 relaunch_of 回指用同一字符串，不重新取钟）
	sc.writeSched([firedEntry("t6", 5 * MIN)]); // t6 有行（pending 孤儿行）→ B 面不进（有行不缝）
	sc.writeState({
		days: {}, launches: [
			{ day: localDay(), part: "wander", sched: "t6", ts: orphanTaskTs, pid: deadPid }, // 断电孤儿·任务型（进程已不在）
			{ day: localDay(), part: "wander", ts: iso(5 * MIN), pid: deadPid + 1 }, // 断电孤儿·班次型
		],
	});
	const r = sc.once();
	const pj = parsed(judgeLines(r.stdout));
	check("场E1（验收6）：首 tick 验尸双判定——任务型 heal、班次型 log-only",
		r.status === 0 && pj.length === 2 && pj.find((x) => x.task === "sched:t6")?.verdict === "heal"
		&& pj.find((x) => x.task === "part:wander")?.verdict === "log-only", JSON.stringify(pj));
	const st = sc.readState();
	const relaunchRows = st.launches.filter((l) => l.sched === "t6" && l.relaunch_of);
	const healPrompts = sc.marks().map((m) => String(m.argv.at(-1))).filter((p) => p.includes("更夫补拉"));
	check("场E2（验收6）：任务型 heal 真补拉——relaunch_of 链回指孤儿行、三件套带补拉标题",
		relaunchRows.length === 1 && relaunchRows[0].relaunch_of === orphanTaskTs && healPrompts.length === 1 && healPrompts[0].includes("【更夫补拉·环境死第 1 次"),
		`relaunch=${JSON.stringify(relaunchRows)} prompts=${healPrompts.length}`);
	check("场E3（验收1-补缝①）：t6 有行 → B 面不缝（无 fired-无行缝判定行）+ 台账 healCount=1/count=0",
		!r.stdout.includes("fired-无行缝") && st.watchman?.relaunches?.t6?.healCount === 1 && st.watchman.relaunches.t6.count === 0
		&& st.launches.every((l) => l.autopsy === undefined || typeof l.autopsy === "string"));
	const r2 = sc.once(); // 重启：孤儿行已验（autopsy 位）——不重判不重拉
	check("场E4（幂等）：重启不重验——无判定行、无新补拉、旧行带 autopsy 位",
		judgeLines(r2.stdout).length === 0 && sc.marks().map((m) => String(m.argv.at(-1))).filter((p) => p.includes("更夫补拉")).length === 1
		&& sc.readState().launches.filter((l) => l.autopsy).length === 2, `marks=${sc.marks().length}`);
}

// ---- 场F+G（验收3 接线面 + 验收9 前半）：parent-down 双补不计数 → heal 第 4 次停拉 ----
{
	const sc = mk("f-parentdown");
	sc.writeSched([firedEntry("t9", 5 * MIN)]);
	const pdRow = () => ({ day: localDay(), part: "wander", sched: "t9", ts: iso(4 * MIN), exit: null, signal: "parent-down", pid: deadPid + 2 });
	// boot1/2：连续两次 parent-down 补拉（每 boot 一条新鲜 parent-down 行——systemd stop 后重启的形状）
	sc.writeState({ days: {}, launches: [pdRow()] });
	const r1 = sc.once();
	let st = sc.readState();
	st.launches.push(pdRow()); // 第二次断电：新的 parent-down 行进窗
	sc.writeState(st);
	const r2 = sc.once();
	st = sc.readState();
	check("场F1（验收3）：连续两次 parent-down 补拉后 attempt 仍为 0（healCount=2，crash 账一字未动）",
		parsed(judgeLines(r1.stdout)).every((x) => x.verdict === "heal") && parsed(judgeLines(r2.stdout)).every((x) => x.verdict === "heal")
		&& st.watchman?.relaunches?.t9?.count === 0 && st.watchman.relaunches.t9.healCount === 2,
		`count=${st.watchman?.relaunches?.t9?.count} heal=${st.watchman?.relaunches?.t9?.healCount}`);
	// boot3：第三次环境死 → 仍 heal（3/3 次，窗内最后一次机会）
	st.launches.push(pdRow());
	sc.writeState(st);
	const r3 = sc.once();
	st = sc.readState();
	hearthReset();
	// boot4：第四次环境死 → stop-human（防断电-补拉-又断电无限循环），不补拉
	st.launches.push(pdRow());
	sc.writeState(st);
	const r4 = sc.once();
	const pj4 = parsed(judgeLines(r4.stdout));
	const healTotal = sc.marks().map((m) => String(m.argv.at(-1))).filter((p) => p.includes("更夫补拉")).length;
	check("场G1（验收9前半）：同 sched 三次环境死补拉后第 4 次环境死 verdict=stop-human",
		parsed(judgeLines(r3.stdout))[0]?.verdict === "heal" && pj4.length === 1 && pj4[0].verdict === "stop-human" && judgeLines(r4.stdout)[0].includes("heal"),
		JSON.stringify({ r3: parsed(judgeLines(r3.stdout)), r4: pj4 }));
	check("场G2（验收9前半）：第 4 次不补拉（补拉 prompt 恒 3 次）+ hearth报备升档 + spoor 待审·人",
		healTotal === 3 && hearthPosts().length === 1 && /停拉转人类/.test(hearthPosts()[0]?.body?.text ?? "")
		&& journalText(sc.stig).includes("- **[待审·人]** (conductor)"), `heals=${healTotal} posts=${hearthPosts().length}`);
}

// ---- 场H（验收9后半）：孤儿行龄 >24h → 首验即转待审·人不补 ----
{
	const sc = mk("h-stale-orphan");
	sc.writeSched([firedEntry("t7", 25 * H)]);
	sc.writeState({
		days: {}, launches: [
			{ day: localDay(), part: "wander", sched: "t7", ts: iso(25 * H), pid: deadPid + 3 }, // 隔夜孤儿·任务型
			{ day: localDay(), part: "wander", ts: iso(25 * H), pid: deadPid + 4 }, // 隔夜孤儿·班次型（任何死状 log-only）
		],
	});
	hearthReset();
	const r = sc.once();
	const pj = parsed(judgeLines(r.stdout));
	const st = sc.readState();
	check("场H1（验收9后半）：隔夜孤儿首验即 stop-human（不自动补）+ 班次型照旧 log-only",
		pj.length === 2 && pj.find((x) => x.task === "sched:t7")?.verdict === "stop-human"
		&& pj.find((x) => x.task === "part:wander")?.verdict === "log-only", JSON.stringify(pj));
	check("场H2（验收9后半）：不补拉（无 relaunch 行无补拉 prompt）+ 升档报备/待审·人落账",
		st.launches.every((l) => !l.relaunch_of) && sc.marks().every((m) => !String(m.argv.at(-1)).includes("更夫补拉"))
		&& hearthPosts().length === 1 && journalText(sc.stig).includes("- **[待审·人]** (conductor)"), `posts=${hearthPosts().length}`);
}

// ---- 场I（验收8 主面）：fired-无行缝——log-only 判定、不补、hearth报备、重启不重报 ----
{
	const sc = mk("i-seam");
	sc.writeSched([firedEntry("t8", 1 * H)]);
	sc.writeState({ days: {}, launches: [] });
	hearthReset();
	const r = sc.once();
	const st = sc.readState();
	const pj = parsed(judgeLines(r.stdout));
	check("场I1（验收8）：缝判定行 log-only（task=sched:t8）+ 不自动补（无 relaunch 行/无补拉 prompt）",
		pj.length === 1 && pj[0].task === "sched:t8" && pj[0].verdict === "log-only"
		&& st.launches.every((l) => l.sched !== "t8") && !r.stdout.includes("更夫补拉") && !r.stdout.includes("更夫重拉："),
		JSON.stringify(pj));
	check("场I2（验收8/缘②）：任务型落缝hearth报备发出（sender=conductor/大厅，讣告同款形状：id+死因+fired_at+请人对一眼）",
		(() => { const posts = hearthPosts(); return posts.length === 1 && posts[0]?.body?.sender === "conductor"
		&& /#t8/.test(posts[0]?.body?.text ?? "") && /fired-无行缝/.test(posts[0]?.body?.text ?? "")
		&& /请人对一眼再定补不补/.test(posts[0]?.body?.text ?? "") && /fired_at=/.test(posts[0]?.body?.text ?? ""); })(),
		JSON.stringify(hearthPosts().map((p) => p.body?.text?.slice(0, 50))));
	check("场I3（缘①幂等）：seamShouted 记名在盘（24h 窗），同 entry 重启不重报",
		typeof st.watchman?.seamShouted?.t8 === "string"
		&& (() => { hearthReset(); const r2 = sc.once(); return judgeLines(r2.stdout).length === 0 && hearthPosts().length === 0; })(),
		`seamShouted=${JSON.stringify(st.watchman?.seamShouted)}`);
}

// ---- 场J（验收8 班次尾）：班次型死状不报备（日常运转不是承诺）----
{
	const sc = mk("j-shift");
	hearthReset();
	const r = sc.once({ env: { PI_STUB_EXIT: "1" } }); // 抽卡抽中 wander 即死（班次型 crash）
	const pj = parsed(judgeLines(r.stdout));
	check("场J1（验收8）：班次型死状 → 判定行 log-only（task=part:wander）+ 零hearth报备 + 台账不进",
		r.status === 0 && pj.length === 1 && pj[0].task === "part:wander" && pj[0].verdict === "log-only"
		&& hearthPosts().length === 0 && !("watchman" in sc.readState()), JSON.stringify(pj));
}

// ---- 场K（验收8b 阴性对照）：fired_at >24h 的老 fired → 无判定行无报备（假阳洪水防护）----
{
	const sc = mk("k-stale-seam");
	sc.writeSched([firedEntry("t10", 25 * H)]); // 老条目：行早被 200 行窗口挤出——反查不许把它当缝
	sc.writeState({ days: {}, launches: [] });
	hearthReset();
	const r = sc.once();
	const st = sc.readState();
	check("场K1（验收8b）：>24h 老 fired 静默忽略——无判定行、无报备、seamShouted 不记名",
		r.status === 0 && judgeLines(r.stdout).length === 0 && hearthPosts().length === 0 && !st.watchman?.seamShouted?.t10,
		`lines=${judgeLines(r.stdout).length} posts=${hearthPosts().length}`);
}

// ---- 场L（验收8c）：hearth不可达 → 判定行照出、抽卡照跑、无 crash ----
{
	const sc = mk("l-hearth-dead");
	sc.writeSched([firedEntry("t8", 1 * H)]);
	sc.writeState({ days: {}, launches: [] });
	const r = sc.once({ env: { HEARTH_URL: "http://127.0.0.1:9" } }); // 死端口（discarding 端口，本地立即拒连）
	const st = sc.readState();
	check("场L1（验收8c）：HEARTH_URL 死端口 → 判定行照出 + 抽卡照跑 + 无 crash + 失败出声不拦",
		r.status === 0 && parsed(judgeLines(r.stdout)).some((x) => x.task === "sched:t8" && x.verdict === "log-only")
		&& r.stdout.includes("抽卡：wander") && out(r).includes("hearth报备失败") && typeof st.watchman?.seamShouted?.t8 === "string",
		(out(r).match(/hearth报备失败[^\n]*/) || ["(无报备失败行)"])[0].slice(0, 100));
}

// ---- 场M（dry-run）：验尸只彩排——不写不拉不报 ----
{
	const sc = mk("m-dry");
	sc.writeSched([firedEntry("t8", 1 * H)]);
	sc.writeState({ days: {}, launches: [{ day: localDay(), part: "wander", sched: "t6", ts: iso(5 * MIN), pid: deadPid + 5 }] });
	hearthReset();
	const stateBefore = fs.readFileSync(sc.stateFile, "utf8");
	const r = sc.once({ args: ["--once", "--dry-run"] });
	check("场M1：dry-run 验尸彩排（将判/将报行出声）——state 原封、不 spawn、不报备",
		r.status === 0 && r.stdout.includes("[dry-run] 更夫验尸将判无主行 sched:t6") && r.stdout.includes("[dry-run] 更夫验尸将报 fired-无行缝 #t8")
		&& fs.readFileSync(sc.stateFile, "utf8") === stateBefore && sc.marks().length === 0 && hearthPosts().length === 0,
		(r.stdout.match(/\[conductor\] \[dry-run\] 更夫[^\n]*/) || ["(无)"])[0].slice(0, 120));
}

// ---- 场N（--status 面 + 接线位静态钉）：watchman 账可见、验尸在一切早退之前 ----
{
	const scI = mk("i-seam"); // 复用场 I 的盘（seamShouted 在账）
	const r = scI.once({ args: ["--status"] });
	let st = null; try { st = JSON.parse(r.stdout); } catch { /* 红面走 undefined */ }
	check("场N1：--status 带 watchman 面（seamShouted/relaunches 不用翻 state.json 猜）",
		st?.watchman?.seamShouted?.t8 !== undefined, `watchman=${JSON.stringify(st?.watchman)?.slice(0, 60)}`);
	const src = fs.readFileSync(CONDUCTOR, "utf8").replace(/\/\/[^\n]*/g, ""); // 剥行注释：注释掉的接线不算接线
	const retroIdx = src.indexOf("await heartbeatRetroFire(st)");
	const autopsyIdx = src.indexOf("await watchmanFirstTickAutopsy(st)");
	const budgetIdx = src.indexOf("if (spend >= DAILY_BUDGET)");
	check("场N2：接线位——验尸在 retro 心跳之后、预算/忙判一切早退之前（搬位即报警）",
		retroIdx > 0 && autopsyIdx > retroIdx && budgetIdx > autopsyIdx, `retro@${retroIdx} < autopsy@${autopsyIdx} < budget@${budgetIdx}`);
}

hearthProc.kill();
console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
