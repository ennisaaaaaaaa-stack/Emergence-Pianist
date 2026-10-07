// T7 死亡最小通道测试（2026-10-01 pianist 施工：launch 先写后做 + 死前状态入账）。
// 09-28 00:28 事故：清道夫误杀收尾中的 wander，报告/遥测尾批/launch 记录三失——死掉的分身
// 连「它启动过」都没留下。病灶：conductor 的 launches.push 在收工之后，分身中途死整行蒸发。
// 修法：① spawn 前先落 pending 行 {day,part,ts,pid?}，收工回填同一行 exit/events/faceHash
//（现状字段一个不少）；② 死因入账——child 被信号杀 → 同行回填 signal=死因、exit=null；
// conductor 自身被 SIGTERM → 在途行补 signal="parent-down" 落盘后再退。
// 读侧兼容钉：pending 行（无 exit 字段）不被冷却门（找 exit===0）/退避门（只认预取账）
// 误读为有效裁决。dry-run 演练可见（打印将落的 pending 行与回填计划）。
// 测法：kill 场景一/二真 spawn（长命 pi 替身 + 真 SIGTERM，非模拟）；其余真跑 conductor --once。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, spawnSync } from "node:child_process";

// T16 凭证记账隔离（10/7 复验补钉）：spawn conductor 的测试若不隔离 PORTALK_CRED_*，
// envOrVault 会写真柜/真账本（conductor:launch 假事件混进审计流）。方子同 credentials.test（10/5 密封纪律）。
const __credTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pianist-cred-seal-"));
process.env.PORTALK_CRED_DIR = path.join(__credTmp, "cred");
process.env.PORTALK_CRED_JOURNAL = path.join(__credTmp, "journal.jsonl");

const CWD = path.resolve(import.meta.dirname, "..");
const CONDUCTOR = path.join(CWD, "src", "conductor.mjs");
let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); }

// 密封底（10/5 体验反馈六号缝）：conductor 会话里跑测试，ambient CONDUCTOR_* 顺 process.env 漏给被测进程——
// 剥净起底 + 头顶灌假 ambient 自证（与 conductor-install-test 同款方子，密封再破自己的断言会叫）。
Object.assign(process.env, { CONDUCTOR_EVENT_TABLE: "ambient-seal-probe-not-real", CONDUCTOR_DAILY_BUDGET: "77", CONDUCTOR_SVPS_SSH: "ambient-seal-host-not-real", CONDUCTOR_SPOOR_FACE_COOLDOWN_H: "99" });
const CLEAN_ENV = { ...process.env };
for (const k of Object.keys(CLEAN_ENV)) if (/^CONDUCTOR_/.test(k)) delete CLEAN_ENV[k];


const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "launch-ledger-"));
const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const drawLine = (s) => (s.match(/抽卡：[^\n]*/) || ["(无抽卡行)"])[0];

// 每场景独立 state 目录（kill 场景要轮询 pending 行，不能串台）
function mkScenario(name) {
	const dir = path.join(tmp, name);
	const stateDir = path.join(dir, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	fs.mkdirSync(path.join(dir, "telemetry"), { recursive: true });
	const hotspotOut = path.join(dir, "hotspots", "latest.json");
	fs.mkdirSync(path.dirname(hotspotOut), { recursive: true });
	// 新鲜热点报告：心跳安静（本测 launch 账，不测心跳）
	fs.writeFileSync(hotspotOut, JSON.stringify({ v: 1, generatedAt: new Date().toISOString() }));
	const stateFile = path.join(stateDir, "state.json");
	const st = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return { days: {}, launches: [] }; } };
	const env = (extra = {}) => ({
		...CLEAN_ENV,
		CONDUCTOR_STATE_DIR: stateDir,
		PIANIST_TELEMETRY_DIR: path.join(dir, "telemetry"),
		CONDUCTOR_HOTSPOT_OUT: hotspotOut,
		CONDUCTOR_IDLE_NOW: "1",
		CONDUCTOR_DAILY_BUDGET: "999",
		...extra,
	});
	return { dir, stateFile, st, env };
}

// pi 替身：exit 0 秒退（正常收工）/ 长命（kill 场景——SIGTERM 默认死法收场）
const piStub = path.join(tmp, "pi-stub.mjs");
fs.writeFileSync(piStub, "process.exit(0);\n");
const piLong = path.join(tmp, "pi-long.mjs");
fs.writeFileSync(piLong, "console.log('pi-long alive');\nsetInterval(() => {}, 1 << 30);\n");

// kill 场景共用底座：异步拉起 conductor，轮询等 pending 行带 pid 落盘（先写后做的实证点）
async function spawnOnceAndAwaitPending(sc, extra = {}, timeoutMs = 20_000) {
	const p = spawn(process.execPath, [CONDUCTOR, "--once"], { env: sc.env(extra), stdio: ["ignore", "pipe", "pipe"] });
	let out = ""; let err = "";
	p.stdout.on("data", (d) => { out += d.toString(); });
	p.stderr.on("data", (d) => { err += d.toString(); });
	const done = new Promise((resolve) => p.on("close", (code) => resolve({ code, out, err })));
	const t0 = Date.now();
	let pending = null;
	while (Date.now() - t0 < timeoutMs) {
		pending = (sc.st().launches ?? []).find((l) => l.pid !== undefined) ?? null;
		if (pending) break;
		await new Promise((r) => setTimeout(r, 50));
	}
	return { p, done, pending, output: () => out + err };
}

// ---- 场A：正常收工——pending 行先入账，回填同一行（现状字段一个不少 + pid）----
{
	const sc = mkScenario("a-normal");
	const r = spawnSync(process.execPath, [CONDUCTOR, "--once"], {
		env: sc.env({ CONDUCTOR_PARTS: "wander", CONDUCTOR_PI_BIN: piStub }), encoding: "utf8", timeout: 60_000,
	});
	const s = sc.st();
	const l = (s.launches ?? []).at(-1);
	check("A1：出声——先写后做+pending 入账+回填报数", r.status === 0
		&& r.stdout.includes("launch 先写后做") && r.stdout.includes("pending 行已入账") && r.stdout.includes("收工 exit=0"),
		drawLine(r.stdout).slice(0, 120));
	check("A2：回填同一行（launches 仍 1 行；pid+exit=0+day/part/ts 齐）",
		s.launches.length === 1 && typeof l?.pid === "number" && l.exit === 0
			&& l.day === today && l.part === "wander" && typeof l.ts === "string",
		`row=${JSON.stringify(l)}`);
	check("A3：正常收工行无 signal 字段（与死行形状可区分的前提）", l.signal === undefined);
}

// ---- 场B（kill 场景一）：child 被信号杀（conductor 活着）——同行回填 signal=SIGTERM ----
{
	const sc = mkScenario("b-child-kill");
	const { done, pending, output } = await spawnOnceAndAwaitPending(sc, { CONDUCTOR_PARTS: "wander", CONDUCTOR_PI_BIN: piLong });
	check("B1：child 还活着时 pending 行已在账上（{day,part,ts,pid}，无 exit 无 signal）",
		pending !== null && pending.day === today && pending.part === "wander" && typeof pending.ts === "string"
			&& pending.exit === undefined && pending.signal === undefined,
		pending ? `pid=${pending.pid}` : "(轮询超时)");
	process.kill(pending.pid, "SIGTERM"); // 对 child 发信号——conductor 活着收尸
	const rb = await done;
	const lb = sc.st().launches.at(-1);
	check("B2：死因入账——signal=SIGTERM、exit=null（与正常收工行形状可区分）",
		lb?.signal === "SIGTERM" && lb.exit === null && lb.pid === pending.pid && lb.part === "wander",
		`row=${JSON.stringify(lb)}`);
	check("B3：出声——死于信号 SIGTERM（conductor 不崩，账目收干净后 exit 0）",
		rb.code === 0 && output().includes("死于信号 SIGTERM"),
		(output().match(/死于信号[^\n]*/) || ["(无死因行)"])[0].slice(0, 160));
}

// ---- 场C（kill 场景二）：--once 的 conductor 本体被 SIGTERM——在途行补 parent-down ----
{
	const sc = mkScenario("c-parent-down");
	const { p, done, pending, output } = await spawnOnceAndAwaitPending(sc, { CONDUCTOR_PARTS: "wander", CONDUCTOR_PI_BIN: piLong });
	check("C1：在途 pending 行可见（pid 已入账）", pending !== null, pending ? `pid=${pending.pid}` : "(轮询超时)");
	process.kill(p.pid, "SIGTERM"); // 对 conductor 本体发信号（systemd stop 形状）——child 成孤儿
	const rc = await done;
	const lc = sc.st().launches.at(-1);
	check("C2：parent-down 入账——在途行补 signal=parent-down、exit=null，落盘后才退出",
		lc?.signal === "parent-down" && lc.exit === null && lc.pid === pending?.pid && rc.code === 0,
		`row=${JSON.stringify(lc)} conductorExit=${rc.code}`);
	check("C3：出声——死也留名（SIGTERM 补账行进 stdout）", output().includes("parent-down"),
		(output().match(/\[conductor\] SIGTERM[^\n]*/) || ["(无行)"])[0].slice(0, 180));
	try { process.kill(lc.pid, "SIGKILL"); } catch { /* 已死——现场卫生，孤儿替身补刀 */ }
}

// ---- 场D：pending 行不被冷却门误读（读侧兼容面钉）----
{
	const sc = mkScenario("d-cooldown-compat");
	// fixture workbench：一张牌面（冷却门要用 faceHash）
	const wbRoot = path.join(sc.dir, "stig");
	fs.mkdirSync(path.join(wbRoot, "workbench", "alpha"), { recursive: true });
	fs.writeFileSync(path.join(wbRoot, "workbench", "alpha", "STATUS.md"), [
		"# alpha", "", "## 下一步", "",
		"- T1 [the author] 测试条目｜出处：collab#100｜判据：npm test 全绿｜到期：2026-10-05",
		"", "## 卡在哪", "", "- 无。",
	].join("\n"));
	const run = (extra = {}) => spawnSync(process.execPath, [CONDUCTOR, "--once"], {
		env: sc.env({ CONDUCTOR_PARTS: "spoor-session", CONDUCTOR_STIGMERGY_ROOT: wbRoot, CONDUCTOR_PI_BIN: piStub, ...extra }),
		encoding: "utf8", timeout: 60_000,
	});
	// D1：预挂 pending spoor 行（无 exit/faceHash——先写后做的真形状）→ 冷却门不认，照抽
	fs.writeFileSync(sc.stateFile, JSON.stringify({ days: {}, launches: [{ day: today, part: "spoor-session", ts: new Date().toISOString() }] }));
	const rd1 = run();
	const sd1 = sc.st();
	check("D1：pending spoor 行不触发冷却（无 exit=不构成有效裁决，照抽）",
		rd1.status === 0 && rd1.stdout.includes("抽卡：spoor-session") && !rd1.stdout.includes("牌面指纹未变"),
		drawLine(rd1.stdout).slice(0, 120));
	check("D2：旧 pending 行原样保留（不回填不误标——诚实账），新行完整回填",
		sd1.launches.length === 2 && sd1.launches[0].exit === undefined && sd1.launches[0].signal === undefined
			&& sd1.launches[1].exit === 0 && typeof sd1.launches[1].faceHash === "string",
		`rows=${sd1.launches.length}`);
	// D3：信号杀死的 spoor 行（faceHash 同、exit=null+signal）→ 也不构成有效裁决
	fs.writeFileSync(sc.stateFile, JSON.stringify({
		days: sd1.days,
		launches: [{ day: today, part: "spoor-session", ts: new Date().toISOString(), exit: null, signal: "SIGTERM", events: null, faceHash: sd1.launches.at(-1)?.faceHash }],
	}));
	const rd3 = run();
	check("D3：signal 死行不算「裁过」（exit===0 判据不认死行，照抽）",
		rd3.status === 0 && rd3.stdout.includes("抽卡：spoor-session") && !rd3.stdout.includes("牌面指纹未变"),
		drawLine(rd3.stdout).slice(0, 120));
	// D4（对照）：真收工行（exit=0+faceHash）→ 冷却照常生效（修读侧不拆门）
	const rd4 = run();
	check("D4：对照——真收工行冷却门照常生效（兼容面不拆门）",
		rd4.status === 0 && rd4.stdout.includes("牌面指纹未变") && !rd4.stdout.includes("抽卡："),
		(rd4.stdout.match(/牌面指纹未变[^\n]*/) || ["(无行)"])[0].slice(0, 140));
}

// ---- 场E：pending 行不被退避门误读（退避账只认预取成败，不认 launch 行）----
{
	const sc = mkScenario("e-backoff-compat");
	// 好 ssh 替身：预取成功（2 行牌面）——证明 pending 行在场时正常路径分毫不乱
	const okSsh = path.join(sc.dir, "ssh-ok");
	fs.writeFileSync(okSsh, "#!/bin/sh\ncat <<'EOF'\n[{\"id\":7,\"thread_id\":1,\"cosine\":0.5,\"signal_text\":\"row-seven\",\"signal_source\":\"test\",\"logged_at\":\"2026-10-01T00:00:00Z\"},{\"id\":9,\"thread_id\":2,\"cosine\":0.7,\"signal_text\":\"row-nine\",\"signal_source\":\"test\",\"logged_at\":\"2026-10-01T00:00:00Z\"}]\nEOF\n");
	fs.chmodSync(okSsh, 0o755);
	fs.writeFileSync(sc.stateFile, JSON.stringify({ days: {}, launches: [{ day: today, part: "env-event", ts: new Date().toISOString() }] }));
	const r = spawnSync(process.execPath, [CONDUCTOR, "--once"], {
		env: sc.env({
			CONDUCTOR_PARTS: "env-event", CONDUCTOR_PI_BIN: piStub,
			CONDUCTOR_SSH_BIN: okSsh, CONDUCTOR_SVPS_SSH: "ignored-host",
		}),
		encoding: "utf8", timeout: 60_000,
	});
	const s = sc.st();
	check("E1：pending env-event 行不惊动退避门（照抽，无退避出声）",
		r.status === 0 && r.stdout.includes("抽卡：env-event") && !r.stdout.includes("今日退避"),
		drawLine(r.stdout).slice(0, 140));
	check("E2：退避账未动（fail_streak 不虚记、backoff 不挂），预取成功照常推进 last_env_event_id",
		(s.env_event_fail_streak ?? 0) === 0 && s.env_event_backoff_day === undefined && s.last_env_event_id === 9,
		`streak=${s.env_event_fail_streak} lastId=${s.last_env_event_id}`);
	check("E3：pending 行不占完成位——旧行仍 pending，新行 exit=0+events=9",
		s.launches.length === 2 && s.launches[0].exit === undefined && s.launches[0].signal === undefined
			&& s.launches[1].exit === 0 && s.launches[1].events === 9,
		`rows=${s.launches.length}`);
}

// ---- 场F：dry-run 演练可见——打印将落的 pending 行与回填计划，不落盘 ----
{
	const sc = mkScenario("f-dry");
	const r = spawnSync(process.execPath, [CONDUCTOR, "--once", "--dry-run"], {
		env: sc.env({ CONDUCTOR_PARTS: "wander" }), encoding: "utf8", timeout: 60_000,
	});
	check("F1：dry-run 打印将落的 pending 行（含 part）",
		r.status === 0 && r.stdout.includes("[dry-run] launch 先写后做预演") && r.stdout.includes("pending 行") && r.stdout.includes('"part":"wander"'),
		(r.stdout.match(/\[dry-run\] launch[^\n]*/) || ["(无行)"])[0].slice(0, 160));
	check("F2：dry-run 打印回填计划（收工字段 + 两条死路 signal）",
		r.stdout.includes("回填计划") && r.stdout.includes("signal") && r.stdout.includes("parent-down"),
		(r.stdout.match(/回填计划[^\n]*/) || ["(无行)"])[0].slice(0, 200));
	check("F3：彩排不落盘（state 未生成）", !fs.existsSync(sc.stateFile) || (sc.st().launches ?? []).length === 0);
	const r2 = spawnSync(process.execPath, [CONDUCTOR, "--once", "--dry"], {
		env: sc.env({ CONDUCTOR_PARTS: "wander" }), encoding: "utf8", timeout: 60_000,
	});
	check("F4：--dry 短同义入口等价（同打印 pending 行预演）",
		r2.status === 0 && r2.stdout.includes("[dry-run] launch 先写后做预演"));
}

console.log(`\n${pass}/${total} checks passed`);
process.exit(pass === total ? 0 : 1);
