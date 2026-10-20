// conductor 本地血源切换测试（2026-10-12 dualcard 交付一）：env-event 预取从写死 ssh 拉
// the-remote 改本地优先（CONDUCTOR_EVENT_SOURCE=local/remote/local,remote，默认 local,remote）。
// 本地=直读 sqlite3（CONDUCTOR_LOCAL_EVENT_DB，默认 organ-runtime wake.db，表名同 eventTable()）；
// 本地/远端两套行号空间→两个游标（last_env_event_local_id / last_env_event_id 各管各的）。
// 覆盖面：A local 单源消费+游标推进；B 本地失败回落 remote（回落不是失败：病名不触发、退避账不动）；
// C 本地空+remote 空→真空 []；D 双失败→null 降级；E 游标独立性（双向）；F tideline-threads 新牌
//（牌面/空牌分叉/池内/prompt 注入链）。测法：真跑 conductor --once（游标要真落 state 才可断言），
// pi 与 retropad 全程替身（真钱零花铁律），本地库与远端库都是真 sqlite3 夹具（不用 mock fs——
// env-event-prefetch-test 的 stub 先例），远端经 ssh 替身双层 shell 真解析。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// T16 凭证记账隔离（同 env-event-prefetch-test 方子）：spawn conductor 的测试不隔离
// PORTALK_CRED_*，envOrVault 会写真柜/真账本（conductor:launch 假事件混进审计流）。
const __credTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pianist-cred-seal-"));
process.env.PORTALK_CRED_DIR = path.join(__credTmp, "cred");
process.env.PORTALK_CRED_JOURNAL = path.join(__credTmp, "journal.jsonl");

const CWD = path.resolve(import.meta.dirname, "..");
const CONDUCTOR = path.join(CWD, "src", "conductor.mjs");
let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); }

// 密封底（同款方子）：ambient CONDUCTOR_* 剥净起底 + 头顶灌假 ambient 自证（密封再破自己的断言会叫）
Object.assign(process.env, { CONDUCTOR_EVENT_TABLE: "ambient-seal-probe-not-real", CONDUCTOR_EVENT_SOURCE: "remote", CONDUCTOR_LOCAL_EVENT_DB: "/ambient-seal-not-real.db", CONDUCTOR_TIDELINE_DB: "/ambient-seal-tide-not-real.db", CONDUCTOR_DAILY_BUDGET: "77", CONDUCTOR_SVPS_SSH: "ambient-seal-host-not-real" });
const CLEAN_ENV = { ...process.env };
for (const k of Object.keys(CLEAN_ENV)) if (/^CONDUCTOR_/.test(k)) delete CLEAN_ENV[k];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-local-events-"));
const telDir = path.join(tmp, "telemetry");
fs.mkdirSync(telDir, { recursive: true });

// pi / retropad 替身（.mjs 尾才被当入口直跑——CONDUCTOR_PI_BIN 契约）：真钱零花铁律
const piStub = path.join(tmp, "pi-stub.mjs");
fs.writeFileSync(piStub, "process.exit(0);\n");
const retropadStub = path.join(tmp, "retropad-stub.mjs");
fs.writeFileSync(retropadStub, "process.exit(0);\n");
// 热点报告 fixture：新鲜（generatedAt=now）→ 非 dry 的 --once 不会真扫真落盘（心跳判新鲜跳过）
const hotspotOut = path.join(tmp, "hotspots", "latest.json");
fs.mkdirSync(path.dirname(hotspotOut), { recursive: true });
fs.writeFileSync(hotspotOut, JSON.stringify({ v: 1, generatedAt: new Date().toISOString(), hotspots: [], errorHotspots: [] }, null, 2));

const drawLine = (s) => (s.match(/抽卡：[^\n]*/) || ["(无抽卡行)"])[0];
const st = (stateDir) => JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));

function once({ stateDir, extra = {}, args = ["--once"] }) {
	fs.mkdirSync(stateDir, { recursive: true });
	return spawnSync(process.execPath, [CONDUCTOR, ...args], {
		env: {
			...CLEAN_ENV,
			CONDUCTOR_PARTS: "env-event",
			CONDUCTOR_IDLE_NOW: "1",
			CONDUCTOR_STATE_DIR: stateDir,
			PIANIST_TELEMETRY_DIR: telDir,
			CONDUCTOR_PI_BIN: piStub,
			CONDUCTOR_RETROPAD_BIN: retropadStub,
			CONDUCTOR_HOTSPOT_OUT: hotspotOut,
			CONDUCTOR_HOTSPOT_DIR: path.join(tmp, "no-such-dir"),
			CONDUCTOR_DAILY_BUDGET: "999",
			PIANIST_SHELL_URL: "http://127.0.0.1:1",
			...extra,
		},
		encoding: "utf8", timeout: 60_000,
	});
}

// ---- 夹具库（真 sqlite3，照 organ-runtime wake.db 真实 schema）：3 新 + 1 已回放 ----
const localDb = path.join(tmp, "local-wake.db");
const mkLocal = spawnSync("sqlite3", [localDb, `CREATE TABLE wake_log (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL, cosine REAL NOT NULL, signal_text TEXT NOT NULL, signal_source TEXT NOT NULL DEFAULT 'user_message', signal_at TEXT, logged_at TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'shadow', replay_day TEXT);
INSERT INTO wake_log (id, thread_id, cosine, signal_text, signal_source, signal_at, logged_at, replay_day) VALUES
 (1, 10, 0.5, 'local-one', 'moonshake:eye.rss:test', '2026-10-12T00:00:00+09:00', '2026-10-12T00:00:01+09:00', NULL),
 (2, 11, 0.6, 'local-two', 'moonshake:ear:test', '2026-10-12T00:01:00+09:00', '2026-10-12T00:01:01+09:00', NULL),
 (3, 12, 0.7, 'local-three', 'moonshake:eye.rss:test', '2026-10-12T00:02:00+09:00', '2026-10-12T00:02:01+09:00', NULL),
 (9, 13, 0.8, 'local-replayed', 'moonshake:eye.rss:test', '2026-10-11T00:00:00+09:00', '2026-10-11T00:00:01+09:00', '2026-10-11');`], { encoding: "utf8" });
check("夹具：本地 wake.db 就位（wake_log 表 3 新 + 1 已回放）", mkLocal.status === 0, (mkLocal.stderr || "").trim().slice(0, 120));

// 远端夹具库（表名跟着 eventTable() 走——本地/远端共用 CONDUCTOR_EVENT_TABLE，本测全链 wake_log）：2 新 + 1 已回放
const remoteDb = path.join(tmp, "remote-mem.db");
const mkRemote = spawnSync("sqlite3", [remoteDb, `CREATE TABLE wake_log (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL, cosine REAL NOT NULL, signal_text TEXT NOT NULL, signal_source TEXT NOT NULL DEFAULT 'user_message', signal_at TEXT, logged_at TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'shadow', replay_day TEXT);
INSERT INTO wake_log (id, thread_id, cosine, signal_text, signal_source, signal_at, logged_at, replay_day) VALUES
 (7, 1, 0.5, 'row-seven', 'test', '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z', NULL),
 (8, 1, 0.5, 'row-eight-replayed', 'test', '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z', '2026-09-27'),
 (9, 2, 0.7, 'row-nine', 'test', '2026-09-28T00:00:00Z', '2026-09-28T00:00:00Z', NULL);`], { encoding: "utf8" });
check("夹具：远端库就位（wake_log 表 2 新 + 1 已回放）", mkRemote.status === 0, (mkRemote.stderr || "").trim().slice(0, 120));

// ssh 替身（env-event-prefetch-test 先例）：$2=远端命令串，sed 换路径后交本地 shell 真解析
const sshOk = path.join(tmp, "ssh-ok");
fs.writeFileSync(sshOk, `#!/bin/sh
exec sh -c "$(printf '%s' "$2" | sed 's|~/memory/mcp_memory.db|${remoteDb}|g')"
`);
fs.chmodSync(sshOk, 0o755);
// 远端空替身：可达且无新事件（stdout 空=sqlite3 -json 零行形状）
const sshEmpty = path.join(tmp, "ssh-empty");
fs.writeFileSync(sshEmpty, "#!/bin/sh\nexit 0\n");
fs.chmodSync(sshEmpty, 0o755);
// 远端死替身：复刻 no such table 的 stderr 尾行
const sshDead = path.join(tmp, "ssh-dead");
fs.writeFileSync(sshDead, "#!/bin/sh\necho 'Error: in prepare, no such table: event-queue' >&2\nexit 1\n");
fs.chmodSync(sshDead, 0o755);

// 本地无新行夹具（只有已回放行——本地可达但零新）
const localDbQuiet = path.join(tmp, "local-quiet.db");
spawnSync("sqlite3", [localDbQuiet, `CREATE TABLE wake_log (id INTEGER PRIMARY KEY AUTOINCREMENT, thread_id INTEGER NOT NULL, cosine REAL NOT NULL, signal_text TEXT NOT NULL, signal_source TEXT NOT NULL DEFAULT 'user_message', signal_at TEXT, logged_at TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'shadow', replay_day TEXT);
INSERT INTO wake_log (id, thread_id, cosine, signal_text, signal_source, logged_at, replay_day) VALUES (8, 1, 0.5, 'all-replayed', 'test', '2026-10-11T00:00:00+09:00', '2026-10-11T00:00:01+09:00', '2026-10-11');`], { encoding: "utf8" });

const LOCAL_ON = { CONDUCTOR_LOCAL_EVENT_DB: localDb, CONDUCTOR_EVENT_TABLE: "wake_log" };

// ---- A：CONDUCTOR_EVENT_SOURCE=local——夹具 3 行进牌面，游标推本地杆 ----
{
	const dir = path.join(tmp, "A");
	const r = once({ stateDir: path.join(dir, "state"), extra: { CONDUCTOR_EVENT_SOURCE: "local", ...LOCAL_ON } });
	check("A：local 单源——牌面 3 条（>0），已回放行被滤（=3 非 4）",
		r.status === 0 && r.stdout.includes("牌面 3 条（>0）"),
		drawLine(r.stdout).slice(0, 160));
	const s = st(path.join(dir, "state"));
	check("A：游标推进 last_env_event_local_id=3（远端游标未动——本地面不碰远端杆）",
		s.last_env_event_local_id === 3 && s.last_env_event_id === undefined, JSON.stringify({ local: s.last_env_event_local_id, remote: s.last_env_event_id }));
	check("A：launch 行消费账照记（events=3）", s.launches.at(-1)?.events === 3 && s.launches.at(-1)?.exit === 0);

	// A2（E 的本地半边）：消费到 3 后灌新行 id 4 → 只拿新行，游标推到 4
	const ins4 = spawnSync("sqlite3", [localDb, `INSERT INTO wake_log (id, thread_id, cosine, signal_text, signal_source, signal_at, logged_at, replay_day) VALUES (4, 14, 0.4, 'local-four', 'moonshake:ear:test', '2026-10-12T00:03:00+09:00', '2026-10-12T00:03:01+09:00', NULL);`], { encoding: "utf8" });
	check("A2 夹具：新行 id 4 灌入", ins4.status === 0, (ins4.stderr || "").trim().slice(0, 120));
	const r2 = once({ stateDir: path.join(dir, "state"), extra: { CONDUCTOR_EVENT_SOURCE: "local", ...LOCAL_ON } });
	check("A2：游后续消——只拿新行（牌面 1 条（>3）），本地游标推到 4",
		r2.status === 0 && r2.stdout.includes("牌面 1 条（>3）") && st(path.join(dir, "state")).last_env_event_local_id === 4,
		drawLine(r2.stdout).slice(0, 160));

	// E（远端半边）：本地无新行→回落 remote 吃远端行；远端杆推 9，本地杆仍 4（双向独立）
	const rE = once({ stateDir: path.join(dir, "state"), extra: { ...LOCAL_ON, CONDUCTOR_SSH_BIN: sshOk, CONDUCTOR_SVPS_SSH: "ignored-host" } });
	check("E1：默认 local,remote——本地无新行回落 remote，牌面 2 条（>0）+回落行出声",
		rE.status === 0 && rE.stdout.includes("牌面 2 条（>0）") && rE.stdout.includes("回落 remote"),
		drawLine(rE.stdout).slice(0, 160));
	const sE = st(path.join(dir, "state"));
	check("E2：远端游标推进 9，本地游标不被远端消费动（仍 4——两杆互不串门）",
		sE.last_env_event_id === 9 && sE.last_env_event_local_id === 4, JSON.stringify({ local: sE.last_env_event_local_id, remote: sE.last_env_event_id }));
	const rE2 = once({ stateDir: path.join(dir, "state"), extra: { ...LOCAL_ON, CONDUCTOR_SSH_BIN: sshOk, CONDUCTOR_SVPS_SSH: "ignored-host" } });
	check("E3：远端续消——牌面 0 条（>9），两杆原样（9/4）",
		rE2.status === 0 && rE2.stdout.includes("牌面 0 条（>9）") && st(path.join(dir, "state")).last_env_event_id === 9 && st(path.join(dir, "state")).last_env_event_local_id === 4,
		drawLine(rE2.stdout).slice(0, 160));
}

// ---- B：本地失败回落 remote——用 remote 的行，回落不是失败 ----
{
	const dir = path.join(tmp, "B");
	const r = once({ stateDir: path.join(dir, "state"), extra: { CONDUCTOR_LOCAL_EVENT_DB: "/no-such-parent-dir/nope.db", CONDUCTOR_EVENT_TABLE: "wake_log", CONDUCTOR_SSH_BIN: sshOk, CONDUCTOR_SVPS_SSH: "ignored-host" } });
	check("B：本地死→回落 remote 用它的 2 行（牌面 2 条（>0））+回落行出声",
		r.status === 0 && r.stdout.includes("牌面 2 条（>0）") && r.stdout.includes("回落 remote"),
		drawLine(r.stdout).slice(0, 160));
	const both = r.stdout + r.stderr;
	check("B：回落不是失败——病名出声路径不触发（无「病名 no such table」），退避账不动（streak=0）",
		!both.includes("病名 no such table") && st(path.join(dir, "state")).env_event_fail_streak === 0 && st(path.join(dir, "state")).env_event_backoff_day === undefined,
		((both.match(/病名[^\n]*/) || ["(无病名行——对)"])[0]).slice(0, 120));
	const s = st(path.join(dir, "state"));
	check("B：远端游标推 9、本地游标不虚记（本地源失败不推杆）",
		s.last_env_event_id === 9 && s.last_env_event_local_id === undefined, JSON.stringify({ local: s.last_env_event_local_id, remote: s.last_env_event_id }));
}

// ---- C：本地空 + remote 空 → [] 真空（文案分叉：真空≠降级）----
{
	const dir = path.join(tmp, "C");
	const r = once({
		stateDir: path.join(dir, "state"), args: ["--once", "--dry-run"],
		extra: { CONDUCTOR_LOCAL_EVENT_DB: localDbQuiet, CONDUCTOR_EVENT_TABLE: "wake_log", CONDUCTOR_SSH_BIN: sshEmpty, CONDUCTOR_SVPS_SSH: "ignored-host" },
	});
	check("C：本地零新+remote 零行→[] 真空——牌面 0 条 + 真空文案（可达且无新事件），非降级文案",
		r.status === 0 && r.stdout.includes("牌面 0 条（>0）") && r.stdout.includes("队列可达且无新事件") && !r.stdout.includes("不要去探队列"),
		drawLine(r.stdout).slice(0, 160));
}

// ---- D：双失败 → null 降级出声；local 单源死同门 ----
{
	const dir = path.join(tmp, "D");
	const r = once({ stateDir: path.join(dir, "state"), extra: { CONDUCTOR_LOCAL_EVENT_DB: "/no-such-parent-dir/nope.db", CONDUCTOR_EVENT_TABLE: "wake_log", CONDUCTOR_SSH_BIN: sshDead, CONDUCTOR_SVPS_SSH: "ignored-host" } });
	const both = r.stdout + r.stderr;
	check("D：双失败→null——牌面 预取失败降级 + remote 病名照旧出声（路径未动）",
		r.status === 0 && r.stdout.includes("牌面 预取失败降级") && both.includes("病名 no such table"),
		drawLine(r.stdout).slice(0, 160));
	const s = st(path.join(dir, "state"));
	check("D：fail_streak=1（硬失败计数照旧）、两杆都不虚推",
		(s.env_event_fail_streak ?? 0) === 1 && s.last_env_event_id === undefined && s.last_env_event_local_id === undefined,
		`streak=${s.env_event_fail_streak}`);
	const dir2 = path.join(tmp, "D2");
	const r2 = once({ stateDir: path.join(dir2, "state"), extra: { CONDUCTOR_EVENT_SOURCE: "local", CONDUCTOR_LOCAL_EVENT_DB: "/no-such-parent-dir/nope.db", CONDUCTOR_EVENT_TABLE: "wake_log" } });
	check("D2：local 单源死→null 降级不炸（拉不到≠空）",
		r2.status === 0 && r2.stdout.includes("牌面 预取失败降级") && (r2.stdout + r2.stderr).includes("本地源预取失败"),
		drawLine(r2.stdout).slice(0, 160));
}

// ---- F：tideline-threads 新牌（dualcard 交付二）----
{
	// 夹具：threads 表 3 open + 1 explored（weight 拉开序：0.9/0.7/0.5/0.1）
	const tideDb = path.join(tmp, "tideline.db");
	const mkTide = spawnSync("sqlite3", [tideDb, `CREATE TABLE threads (id INTEGER PRIMARY KEY, content TEXT, status TEXT, importance REAL, unresolved REAL, weight REAL);
INSERT INTO threads VALUES (1, 'open-tail-one：遥测里反复出现的 hotspot 形状', 'open', 0.8, 0.6, 0.9),
 (2, 'open-tail-two：09-30 空牌病历没写完的验尸', 'open', 0.7, 0.5, 0.7),
 (3, 'open-tail-three：tideline 桥的退避缝', 'open', 0.6, 0.4, 0.5),
 (4, 'explored-old：已走过的老线', 'explored', 0.1, 0.0, 0.1);`], { encoding: "utf8" });
	check("夹具：tideline 库就位（threads 3 open + 1 explored）", mkTide.status === 0, (mkTide.stderr || "").trim().slice(0, 120));

	const runTide = (extra, args = ["--once", "--dry-run"]) => once({ stateDir: path.join(tmp, "F-state"), extra: { CONDUCTOR_PARTS: "tideline-threads", ...extra }, args });

	const r1 = runTide({ CONDUCTOR_TIDELINE_DB: tideDb });
	check("F1：drawPart 池含新牌（CONDUCTOR_PARTS 过滤后抽中）+牌面行出「N 条线索」",
		r1.status === 0 && r1.stdout.includes("抽卡：tideline-threads（记忆线索探索（tideline threads）），牌面 4 条线索"),
		drawLine(r1.stdout).slice(0, 200));
	check("F1：prompt 注入链生效——threads 参数真进 prompt 文本（3 条 open 到场，含 w/未解度/状态）",
		r1.stdout.includes("[tideline-threads-prompt]") && r1.stdout.includes("open-tail-one") && r1.stdout.includes("open-tail-two") && r1.stdout.includes("open-tail-three")
			&& r1.stdout.includes("w=0.9") && r1.stdout.includes("未解=0.6") && r1.stdout.includes("[explored]"),
		(r1.stdout.split("\n").find((l) => l.includes("[tideline-threads-prompt] - #")) || "(无线头行)").slice(0, 160));
	check("F1：纪律段在场（只读不写 threads 表 / 播种同 wander ≤1 条 w≤0.5）",
		r1.stdout.includes("threads 表你只读不写") && r1.stdout.includes("w 封顶 0.5") && r1.stdout.includes("source=seed"));

	// 表不存在（库在、threads 表没长）：文案 A——「库还没长出来」族，病因行点名 no such table
	const tideNoTable = path.join(tmp, "tideline-no-table.db");
	spawnSync("sqlite3", [tideNoTable, "CREATE TABLE context (id INTEGER, content TEXT);"]);
	const r2 = runTide({ CONDUCTOR_TIDELINE_DB: tideNoTable });
	check("F2：表不存在→空牌面文案 A（库还没长出来，非「没有 open 线索」）+病因行点名 no such table",
		r2.status === 0 && r2.stdout.includes("牌面 预取失败降级（库还没长出来）") && r2.stdout.includes("库还没长出来") && !r2.stdout.includes("没有 open 线索")
			&& (r2.stdout + r2.stderr).includes("no such table: threads"),
		(r2.stderr.match(/tideline-threads[^\n]*/) || ["(无病因行)"])[0].slice(0, 160));

	// 库不存在（父目录都没有）：文案 B——同族降级，病因行是 unable to open（与 A 的区分在病因行）
	const r3 = runTide({ CONDUCTOR_TIDELINE_DB: "/no-such-parent-dir/no-tide.db" });
	check("F3：库不存在→空牌面文案 B（库还没长出来）+病因行 unable to open（不落文件不炸）",
		r3.status === 0 && r3.stdout.includes("库还没长出来") && !r3.stdout.includes("没有 open 线索")
			&& (r3.stdout + r3.stderr).includes("unable to open"),
		(r3.stderr.match(/tideline-threads[^\n]*/) || ["(无病因行)"])[0].slice(0, 160));

	// 表在零行：真无线（与「库还没长出来」分叉——不共用一句）
	const tideEmpty = path.join(tmp, "tideline-empty.db");
	spawnSync("sqlite3", [tideEmpty, "CREATE TABLE threads (id INTEGER PRIMARY KEY, content TEXT, status TEXT, importance REAL, unresolved REAL, weight REAL);"]);
	const r4 = runTide({ CONDUCTOR_TIDELINE_DB: tideEmpty });
	check("F4：表在零行→「没有 open 线索」文案（真无线，与库没长出来分叉）",
		r4.status === 0 && r4.stdout.includes("牌面 0 条线索") && r4.stdout.includes("没有 open 线索") && !r4.stdout.includes("库还没长出来"),
		drawLine(r4.stdout).slice(0, 160));
}

console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
