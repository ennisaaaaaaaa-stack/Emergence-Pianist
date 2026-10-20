// conductor→retro 触发接线测试（2026-10-11 v2-2 接线单）：retro-trigger 三源触发器零调用方——
// 本单把线接在 conductor 心跳位（tick 内 heartbeatHotspotScan 收工之后、预算/忙判早退之前），
// fire 时拉起 retropad（不带 --force：内部幂等复判，双保险）。覆盖面：
//   高热点→判定行+spawn（retropad 全程 stub，真钱零花是本单铁律）；冷却窗内不再 fire；
//   低/零热点→fire=false 不 spawn；报告缺失/坏 JSON→判定不炸（接缝不叠加崩）；
//   state.json 不存在（首战）→due 源照判照写；dry-run 只彩排；--status 面可见。
// 测法：真跑 conductor --once（判定/记账/冷却都是真身），pi 与 retropad 都是替身 .mjs。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// T16 凭证记账隔离（同 hotspot-heartbeat-test 方子）：spawn conductor 真身的测试不隔离
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

// 密封底（同款方子）：ambient CONDUCTOR_* 剥净起底 + 头顶灌假 ambient 自证（密封再破自己的断言会叫）
Object.assign(process.env, { CONDUCTOR_EVENT_TABLE: "ambient-seal-probe-not-real", CONDUCTOR_DAILY_BUDGET: "77", CONDUCTOR_SVPS_SSH: "ambient-seal-host-not-real", CONDUCTOR_RETROPAD_BIN: "ambient-seal-retropad-not-real" });
const CLEAN_ENV = { ...process.env };
for (const k of Object.keys(CLEAN_ENV)) if (/^CONDUCTOR_/.test(k)) delete CLEAN_ENV[k];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-retro-wire-"));
const telDir = path.join(tmp, "telemetry");
fs.mkdirSync(telDir, { recursive: true });
const SHELL_URL = `http://127.0.0.1:${20000 + Math.floor(Math.random() * 20000)}`; // 端口随机（本面无真连，占位防撞）

// fixture 遥测：几行真事件（dailySpendYen/忙判的面——扫描器零事件会自己出声，那是它的活）
fs.writeFileSync(path.join(telDir, "pianist-wander-1-2026-10-11.jsonl"), [
	JSON.stringify({ v: 1, ts: "2026-10-11T00:00:00.000Z", agent: "pianist-wander-1", kind: "session_mark", data: {} }),
	JSON.stringify({ v: 1, ts: "2026-10-11T00:00:01.000Z", agent: "pianist-wander-1", kind: "tool_use", data: { tool: "bash", input: { command: "ls" }, isError: false } }),
	JSON.stringify({ v: 1, ts: "2026-10-11T00:00:02.000Z", agent: "pianist-wander-1", kind: "message_end", data: { usage: { totalTokens: 10, cost: { total: 0.001 } } } }),
	"",
].join("\n"));

// pi 替身：CONDUCTOR_PI_BIN 只认 .js/.mjs 尾，直跑 exit 0（抽卡面照走，钱零花）
const piStub = path.join(tmp, "pi-stub.mjs");
fs.writeFileSync(piStub, "process.exit(0);\n");

// retropad 替身：记账一行（argv 全量——断言「不带 --force」用的就是它）+ exit 0。
// 真钱零花是本单铁律：这里永远不投 Grimoire、不拉分身、不读真报告。
const retropadStub = path.join(tmp, "retropad-stub.mjs");
fs.writeFileSync(retropadStub, [
	'import fs from "node:fs";',
	`fs.appendFileSync(process.env.RETRO_STUB_LOG, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + "\\n");`,
	'console.log("[retropad-stub] 触发器：fire=true reason=stub（替身面：不判不复盘，记账即退）");',
	"process.exit(0);",
].join("\n"));

// 高热点报告 fixture（errorHotspots 3 ≥ 阈值 3 → threshold 源燃；generatedAt=now 让 hotspot 心跳判新鲜不重扫）
function writeReport(file, nHot, nErr) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify({
		v: 1, generatedAt: new Date().toISOString(),
		hotspots: Array.from({ length: nHot }, (_, i) => ({ id: `h${i}` })),
		errorHotspots: Array.from({ length: nErr }, (_, i) => ({ id: `e${i}` })),
	}, null, 2));
}

const marks = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

function once({ stateDir, out, marker, retroState, args = ["--once"] }) {
	fs.mkdirSync(stateDir, { recursive: true });
	return spawnSync(process.execPath, [CONDUCTOR, ...args], {
		env: {
			...CLEAN_ENV,
			CONDUCTOR_PARTS: "wander",
			CONDUCTOR_IDLE_NOW: "1",
			CONDUCTOR_STATE_DIR: stateDir,
			PIANIST_TELEMETRY_DIR: telDir,
			CONDUCTOR_HOTSPOT_OUT: out,
			CONDUCTOR_HOTSPOT_DIR: path.join(tmp, "no-such-dir"), // 报告缺失/坏 JSON 面让扫描器必败不覆盖 fixture
			CONDUCTOR_RETROPAD_BIN: retropadStub,
			CONDUCTOR_RETRO_STATE: retroState,
			CONDUCTOR_PI_BIN: piStub,
			CONDUCTOR_DAILY_BUDGET: "999",
			PIANIST_SHELL_URL: SHELL_URL,
			RETRO_STUB_LOG: marker,
		},
		encoding: "utf8",
	});
}

// ---- 场1：高热点（errorHotspots 3 ≥ 阈值 3）→ 判定行 fire=true + retropad 被 spawn（stub）----
const dir1 = path.join(tmp, "s1");
const out1 = path.join(dir1, "hotspots", "latest.json");
const mark1 = path.join(dir1, "retro-stub.log");
const retroState1 = path.join(dir1, "retro-state.json");
writeReport(out1, 0, 3);
const r1 = once({ stateDir: path.join(dir1, "state"), out: out1, marker: mark1, retroState: retroState1 });
const judge1 = (r1.stdout.match(/\[conductor\] retro 触发判定[^\n]*/) || ["(无判定行)"])[0];
check("场1：判定行 fire=true reason=threshold", r1.status === 0 && r1.stdout.includes("retro 触发判定：fire=true reason=threshold"), judge1);
const fired1 = marks(mark1);
check("场1：retropad 被 spawn 恰一次（stub 记账）", fired1.length === 1, `marks=${fired1.length}`);
const argv1 = fired1.length ? JSON.parse(fired1[0]).argv : [];
check("场1：spawn 形状——指 report/state、不带 --force",
	argv1.includes("--report") && argv1[argv1.indexOf("--report") + 1] === out1
	&& argv1.includes("--state") && argv1[argv1.indexOf("--state") + 1] === retroState1
	&& !argv1.includes("--force"), JSON.stringify(argv1));
const s1 = JSON.parse(fs.readFileSync(path.join(dir1, "state", "state.json"), "utf8"));
const lf1 = s1.last_retro_fire ?? {}; // 前场红面时不崩：后续断言拿 undefined 照样红（不假绿）
check("场1：记账 last_retro_fire（ts/reason/detail/exit/ms 对齐 last_hotspot_scan 形状）",
	lf1.reason === "threshold" && lf1.exit === 0
	&& Number.isFinite(lf1.ms) && typeof lf1.ts === "string"
	&& typeof lf1.detail === "string", JSON.stringify(s1.last_retro_fire));
check("场1：不虚记抽卡账外的账（draws/launches 照常、无 retro 混入）",
	s1?.days?.[today]?.draws === 1 && s1.days[today]?.launches === 1 && !("retro" in (s1.days[today] ?? {})),
	`draws=${s1?.days?.[today]?.draws}`);

// ---- 场2：冷却窗内第二次判定 → 不再 spawn（fired:false, why:"cooldown"）----
const r2 = once({ stateDir: path.join(dir1, "state"), out: out1, marker: mark1, retroState: retroState1 });
check("场2：冷却内不再 spawn（记账不增）+ 冷却行出声",
	r2.status === 0 && marks(mark1).length === 1 && r2.stdout.includes("retro 心跳冷却中") && r2.stdout.includes("连环拉保护"),
	(r2.stdout.match(/\[conductor\] retro 心跳冷却中[^\n]*/) || ["(无冷却行)"])[0].slice(0, 160));
check("场2：冷却内记账原样（last_retro_fire.ts 不动）", (JSON.parse(fs.readFileSync(path.join(dir1, "state", "state.json"), "utf8")).last_retro_fire ?? {}).ts === lf1.ts && lf1.ts !== undefined);
// 场2b：冷却过期（ts 拨回 7h 前 > 6h 窗）→ 再战
const s2b = JSON.parse(fs.readFileSync(path.join(dir1, "state", "state.json"), "utf8"));
s2b.last_retro_fire = s2b.last_retro_fire ?? { ts: undefined }; // 前场红面不崩：下面赋值安全，断言已红
s2b.last_retro_fire.ts = new Date(Date.now() - 7 * 3600_000).toISOString(); // 拨回 7h 前 > 6h 窗
fs.writeFileSync(path.join(dir1, "state", "state.json"), JSON.stringify(s2b));
const r2b = once({ stateDir: path.join(dir1, "state"), out: out1, marker: mark1, retroState: retroState1 });
check("场2b：冷却过期再战（判定行回来+spawn 第二次）",
	r2b.status === 0 && r2b.stdout.includes("retro 触发判定：fire=true") && marks(mark1).length === 2, `marks=${marks(mark1).length}`);
// 场2c：自家钟过窗（7h 前）但带外 retropad 刚落账（retro/state.json lastRetroAt=now）→ 冷却按双源之新，不双拉
const s2c = JSON.parse(fs.readFileSync(path.join(dir1, "state", "state.json"), "utf8"));
s2c.last_retro_fire = s2c.last_retro_fire ?? { ts: undefined, reason: undefined }; // 前场红面不崩
s2c.last_retro_fire.ts = new Date(Date.now() - 7 * 3600_000).toISOString(); // 自家钟拨过窗
fs.writeFileSync(path.join(dir1, "state", "state.json"), JSON.stringify(s2c));
fs.mkdirSync(path.dirname(retroState1), { recursive: true });
fs.writeFileSync(retroState1, JSON.stringify({ v: 1, lastRetroAt: new Date().toISOString(), runs: 2 }, null, 2)); // 带外刚裁过
const r2c = once({ stateDir: path.join(dir1, "state"), out: out1, marker: mark1, retroState: retroState1 });
check("场2c：自家钟过窗但带外刚裁过 → 冷却按带外钟（不 spawn，冷却行点名「带外」）",
	r2c.status === 0 && marks(mark1).length === 2 && r2c.stdout.includes("retro 心跳冷却中") && r2c.stdout.includes("带外"),
	(r2c.stdout.match(/\[conductor\] retro 心跳冷却中[^\n]*/) || ["(无冷却行)"])[0].slice(0, 160));
check("场2c：冷却内记账原样（last_retro_fire.ts 不被带外钟改写）",
	(JSON.parse(fs.readFileSync(path.join(dir1, "state", "state.json"), "utf8")).last_retro_fire ?? {}).ts === s2c.last_retro_fire.ts);

// ---- 场3：低/零热点 + 近期复盘历史 → fire=false 不 spawn ----
const dir3 = path.join(tmp, "s3");
const out3 = path.join(dir3, "hotspots", "latest.json");
const mark3 = path.join(dir3, "retro-stub.log");
const retroState3 = path.join(dir3, "retro-state.json");
writeReport(out3, 1, 1); // 总 2 < 阈值 3
fs.mkdirSync(path.dirname(retroState3), { recursive: true });
fs.writeFileSync(retroState3, JSON.stringify({ v: 1, lastRetroAt: new Date().toISOString(), runs: 1 }, null, 2)); // 刚复盘过：due 源不燃
const r3 = once({ stateDir: path.join(dir3, "state"), out: out3, marker: mark3, retroState: retroState3 });
// 冷却双源之新（2026-10-11 第五班）：近期裁决无论是自家还是带外，一律冷却行而非 none 判定行
check("场3：低热点+带外刚裁过 → 冷却行（带外钟）不 spawn",
	r3.status === 0 && r3.stdout.includes("retro 心跳冷却中") && r3.stdout.includes("带外") && marks(mark3).length === 0,
	(r3.stdout.match(/\[conductor\] retro 心跳冷却中[^\n]*/) || ["(无冷却行)"])[0].slice(0, 160));
const s3 = JSON.parse(fs.readFileSync(path.join(dir3, "state", "state.json"), "utf8"));
check("场3：不 fire 不记账（last_retro_fire 无字段）", s3.last_retro_fire === undefined);

// ---- 场4：报告缺失 + state.json 不存在（首战）→ due 源照判、判定不炸、写 state ----
const dir4 = path.join(tmp, "s4");
const out4 = path.join(dir4, "hotspots", "latest.json"); // 不写文件：缺失面
const mark4 = path.join(dir4, "retro-stub.log");
const retroState4 = path.join(dir4, "retro-state.json"); // 不写文件：无历史 → due 立即到期一次
const stateDir4 = path.join(dir4, "state");
const r4 = once({ stateDir: stateDir4, out: out4, marker: mark4, retroState: retroState4 });
check("场4：报告缺失+无历史 → 判定行 fire=true reason=due（首战铺路），conductor 不炸",
	r4.status === 0 && r4.stdout.includes("retro 触发判定：fire=true reason=due"),
	(r4.stdout.match(/\[conductor\] retro 触发判定[^\n]*/) || ["(无判定行)"])[0].slice(0, 160));
check("场4：首战写 state（state.json 落盘、due 记账）", marks(mark4).length === 1
	&& JSON.parse(fs.readFileSync(path.join(stateDir4, "state.json"), "utf8")).last_retro_fire?.reason === "due");

// ---- 场5：坏 JSON 报告 → 判定不炸（接缝容错：null=零热点面，due/判定照跑）----
const dir5 = path.join(tmp, "s5");
const out5 = path.join(dir5, "hotspots", "latest.json");
fs.mkdirSync(path.dirname(out5), { recursive: true });
fs.writeFileSync(out5, "{ 半截写入不是 JSON");
const mark5 = path.join(dir5, "retro-stub.log");
const r5 = once({ stateDir: path.join(dir5, "state"), out: out5, marker: mark5, retroState: path.join(dir5, "retro-state.json") });
check("场5：坏 JSON → 判定行照出（fire=true reason=due，零热点面），进程 exit 0",
	r5.status === 0 && r5.stdout.includes("retro 触发判定：fire=true reason=due") && marks(mark5).length === 1,
	(r5.stdout.match(/\[conductor\] retro 触发判定[^\n]*/) || ["(无判定行)"])[0].slice(0, 160));

// ---- 场6：dry-run 只彩排——判定行出、不 spawn、不落 state ----
const dir6 = path.join(tmp, "s6");
const out6 = path.join(dir6, "hotspots", "latest.json");
writeReport(out6, 0, 5);
const r6 = once({ stateDir: path.join(dir6, "state"), out: out6, marker: path.join(dir6, "retro-stub.log"), retroState: path.join(dir6, "retro-state.json"), args: ["--once", "--dry-run"] });
check("场6：dry-run 判定行+彩排行出、不 spawn 不记账",
	r6.status === 0 && r6.stdout.includes("retro 触发判定：fire=true reason=threshold")
	&& r6.stdout.includes("[dry-run] retro 心跳将拉起") && marks(path.join(dir6, "retro-stub.log")).length === 0
	&& !fs.existsSync(path.join(dir6, "state", "state.json")),
	(r6.stdout.match(/\[conductor\] \[dry-run\] retro[^\n]*/) || ["(无彩排行)"])[0].slice(0, 160));

// ---- 场7：--status 面可见（retro 死活不用翻 journal 猜）----
const r7 = spawnSync(process.execPath, [CONDUCTOR, "--status"], {
	env: { ...CLEAN_ENV, CONDUCTOR_STATE_DIR: path.join(dir1, "state"), PIANIST_TELEMETRY_DIR: telDir, PIANIST_SHELL_URL: SHELL_URL }, encoding: "utf8",
});
let st7 = null;
try { st7 = JSON.parse(r7.stdout); } catch {}
check("场7：--status 带 lastRetroFire（reason/exit 可见）", st7?.lastRetroFire?.reason === "threshold" && st7?.lastRetroFire?.exit === 0,
	`reason=${st7?.lastRetroFire?.reason}`);

// ---- 场8：接线静态断言——retro 判定在 hotspot 心跳之后、预算/忙判早退之前（搬位置/注释掉即报警）----
const src = fs.readFileSync(CONDUCTOR, "utf8").replace(/\/\/[^\n]*/g, ""); // 剥行注释：注释掉的接线不算接线（阴性对照同理红）
const hbIdx = src.indexOf("await heartbeatHotspotScan(st)");
const retroIdx = src.indexOf("await heartbeatRetroFire(st)");
const budgetIdx = src.indexOf("if (spend >= DAILY_BUDGET)");
const busyIdx = src.indexOf("if (idleMs <= IDLE_MS)");
check("场8：接线在 hotspot 收工之后、一切早退之前", hbIdx > 0 && retroIdx > hbIdx && budgetIdx > retroIdx && busyIdx > retroIdx,
	`hb@${hbIdx} < retro@${retroIdx} < budget@${budgetIdx} < busy@${busyIdx}`);

console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
