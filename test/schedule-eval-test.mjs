// schedule 评估器 + 消费接线测试（2026-10-12 schedule-bone 施工）：spec=docs/schedule-spec-v0.1.md
// 六条拍板的可断言面。覆盖：错过跳过（LAST 时窗已过不排队不补跑）/窗口命中/参数透传/
// 预算序（schedule 先吃余额才抽卡——due 顶掉抽卡、预算硬停也管骨头）/权限三档默认 always-ask
//（auto-safe 复用 ACTION_RISK 分流：amber 过 red 挂）/活动窗 env+文件双通道（默认北京
// 10:00-22:00）/存储读写容错/接线回归（判定行、launch 行 sched 字段、--status 面、静态接线位）。
// 测法：纯函数面 in-process（时钟注入）；接线面真跑 conductor --once（pi 替身 stub，真钱零花
// 是本单铁律——不 spawn 真用户会话）。ambient CONDUCTOR_* 密封底 + 头顶灌假自证。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import {
	evaluateSchedule, resolveActiveWindow, scheduleEntryRisk,
	readSchedule, writeSchedule, readActiveHoursFile, emptySchedule, makeEntry,
} from "../src/schedule/index.mjs";

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

// 密封底：ambient CONDUCTOR_* 剥净起底 + 头顶灌假 ambient 自证（密封再破自己的断言会叫）
Object.assign(process.env, {
	CONDUCTOR_SCHEDULE_FILE: "ambient-seal-sched-not-real",
	CONDUCTOR_ACTIVE_HOURS: "ambient-seal-hours-not-real",
	CONDUCTOR_SCHEDULE_PERMISSION: "no-ask", // 若密封破，pending 条目会直接 fire——自证面
	CONDUCTOR_DAILY_BUDGET: "77",
});
const CLEAN_ENV = { ...process.env };
for (const k of Object.keys(CLEAN_ENV)) if (/^CONDUCTOR_/.test(k)) delete CLEAN_ENV[k];
// hearth密封（2026-10-19 fired-无行缝报备泄漏修）：CLEAN_ENV 只剥 CONDUCTOR_* 不封 HEARTH_URL，
// 子进程 conductor 缺省回落真hearth 172.26.176.1:7788——B 面 fired-无行缝报备真打真hearth
//（10/18 深夜 11 发大厅刷屏事故，火源=本文件 w1 场 t1 夹具）。封死端口（discarding，立即拒连）——
// 注意是「显式设死端口」不是 delete：conductor 缺省 HEARTH_URL ?? 真hearth地址，删掉=回落真hearth。
// 报备路径失败不拦（验收 8c 已证），测试面不受影响。
CLEAN_ENV.HEARTH_URL = "http://127.0.0.1:9";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "schedule-eval-"));
const SHELL_URL = `http://127.0.0.1:${20000 + Math.floor(Math.random() * 20000)}`; // 端口随机（本面无真连，占位防撞）

// ============================================================================
// 一、纯函数面（时钟注入，零 spawn）
// ============================================================================
// 固定锚日 2026-10-12（UTC）；北京=UTC+8。窄窗 12:00~14:00Z=北京 20:00~22:00；宽窗全日。
const NARROW = { start: "2026-10-12T12:00:00.000Z", end: "2026-10-12T14:00:00.000Z" };
const WIDE = { start: "2026-10-12T00:00:00.000Z", end: "2026-10-12T23:59:00.000Z" };
function pureEntry(over = {}) {
	return { id: "e1", window: NARROW, part: "wander", params: { thread_id: 33, note: "深耕" }, intent: "窗口命中面", created_by: "test", status: "approved", ...over };
}

// 1. 窗口命中 + 参数透传（§四拍板⑤：复合带参数，params 原样进 due——前端可视化吃结构化数据）
const v1 = evaluateSchedule({ schedule: { entries: [pureEntry()] }, now: "2026-10-12T13:00:00.000Z" }); // 北京 21:00，默认活动窗内
check("纯1：窗口命中 → due，params 深透传",
	v1.due.length === 1 && JSON.stringify(v1.due[0].entry.params) === JSON.stringify({ thread_id: 33, note: "深耕" }),
	`due=${v1.due.length}`);
check("纯2：默认档 always-ask + approved → fire（tierSource=default）",
	v1.due[0]?.tier === "always-ask" && v1.due[0]?.tierSource === "default" && v1.due[0]?.why === "always-ask:approved",
	`tier=${v1.due[0]?.tier} src=${v1.due[0]?.tierSource}`);
// 2. 错过跳过（§五3：LAST 时窗已过 → 不触发不排队，无补跑队列；纯函数幂等——重复评估同判）
const v2a = evaluateSchedule({ schedule: { entries: [pureEntry()] }, now: "2026-10-12T14:01:00.000Z" });
const v2b = evaluateSchedule({ schedule: { entries: [pureEntry()] }, now: "2026-10-12T14:01:00.000Z" });
check("纯3：错过=跳过——end 后 → skipped 不进 due/held，重复评估同判（不排队）",
	v2a.skipped.length === 1 && v2a.skipped[0].why === "window-passed" && v2a.due.length === 0 && v2a.held.length === 0
	&& v2b.skipped.length === 1 && v2b.due.length === 0, `skipped=${v2a.skipped.length}`);
// 3. 未到窗
const v3 = evaluateSchedule({ schedule: { entries: [pureEntry()] }, now: "2026-10-12T11:00:00.000Z" });
check("纯4：未到窗 → waiting，due/skipped/held 全空", v3.waiting === 1 && v3.due.length === 0 && v3.skipped.length === 0 && v3.held.length === 0);
// 4. 活动窗默认值（§五1：不硬编码≠没有初始值——北京 10:00-22:00 兜底）
check("纯5：活动窗默认北京 10:00-22:00（src=default，北京 21:00 在窗内）",
	v1.activeWindow.start === "10:00" && v1.activeWindow.end === "22:00" && v1.activeWindow.source === "default" && v1.activeWindow.inWindow === true,
	`${v1.activeWindow.start}-${v1.activeWindow.end}@${v1.activeWindow.source}`);
const v5 = evaluateSchedule({ schedule: { entries: [pureEntry({ window: WIDE })] }, now: "2026-10-12T15:30:00.000Z" }); // 北京 23:30
check("纯6：默认活动窗外（北京 23:30）→ held outside-active-hours（等活跃时段，不是错过）",
	v5.held.length === 1 && v5.held[0].why === "outside-active-hours" && v5.due.length === 0 && v5.skipped.length === 0);
// 5. env 通道（CONDUCTOR_ACTIVE_HOURS 原文注入）
const v6a = evaluateSchedule({ schedule: { entries: [pureEntry({ window: WIDE })] }, envHours: "09:00-12:00", now: "2026-10-12T03:00:00.000Z" }); // 北京 11:00
check("纯7：env 活动窗生效（09:00-12:00，北京 11:00 在窗内）→ due",
	v6a.due.length === 1 && v6a.activeWindow.source === "env" && v6a.activeWindow.inWindow === true);
const v6b = evaluateSchedule({ schedule: { entries: [pureEntry({ window: WIDE })] }, envHours: "09:00-12:00", now: "2026-10-12T05:00:00.000Z" }); // 北京 13:00
check("纯8：env 活动窗外（北京 13:00 > 12:00）→ held", v6b.held.length === 1 && v6b.held[0].why === "outside-active-hours");
// 6. 文件通道 + env 优先（双通道：env 运维面 > 文件调整通道 > 默认）
const v7a = evaluateSchedule({ schedule: { entries: [pureEntry({ window: WIDE })] }, fileHours: "13:00-15:00", now: "2026-10-12T05:00:00.000Z" }); // 北京 13:00
check("纯9：文件活动窗生效（13:00-15:00，北京 13:00）→ due，src=file",
	v7a.due.length === 1 && v7a.activeWindow.source === "file");
const v7b = evaluateSchedule({ schedule: { entries: [pureEntry({ window: WIDE })] }, envHours: "09:00-12:00", fileHours: "13:00-15:00", now: "2026-10-12T05:00:00.000Z" });
check("纯10：env 在场时压过文件（双通道优先级 env>file）",
	v7b.activeWindow.source === "env" && v7b.held.length === 1, `src=${v7b.activeWindow.source}`);
// 7. 跨午夜环绕（22:00-06:00）
const wrapIn = (h) => evaluateSchedule({ schedule: { entries: [pureEntry({ window: WIDE })] }, envHours: "22:00-06:00", now: `2026-10-12T${h}:00:00.000Z` }).activeWindow.inWindow;
check("纯11：跨午夜活动窗（22:00-06:00）：北京 23:00/05:00 在窗内、07:00 窗外",
	wrapIn("15") === true && wrapIn("21") === true && wrapIn("23") === false, `23:00=${wrapIn("15")} 05:00=${wrapIn("21")} 07:00=${wrapIn("23")}`);
// 8. 非法通道值 → 忽略该通道回落（不炸不猜）
const v8 = resolveActiveWindow({ envHours: "banana", fileHours: "也不是窗", now: "2026-10-12T13:00:00.000Z" });
check("纯12：env/文件值都非法 → 回默认 10:00-22:00 且 invalid 点名两通道",
	v8.source === "default" && v8.start === "10:00" && v8.invalid.includes("env") && v8.invalid.includes("file"));
// 9. 权限三档（§四3：默认 always-ask——信任要挣得）
const v9a = evaluateSchedule({ schedule: { entries: [pureEntry({ status: "pending" })] }, now: "2026-10-12T13:00:00.000Z" });
check("纯13：always-ask 默认档：pending（含 status 缺省）→ held pending-approval",
	v9a.held.length === 1 && v9a.held[0].why === "pending-approval" && v9a.due.length === 0);
const v9b = evaluateSchedule({ schedule: { entries: [{ id: "e9", window: NARROW, part: "wander", params: {}, created_by: "test" }] }, now: "2026-10-12T13:00:00.000Z" }); // 无 status 字段=缺省 pending
check("纯14：status 缺省=落地待确认（always-ask 世界入场形状）→ held", v9b.held.length === 1 && v9b.held[0].why === "pending-approval");
// 10. auto-safe：复用 ACTION_RISK 分流——amber 自动过、red 挂审批（§四3）
const v10 = evaluateSchedule({ schedule: { entries: [pureEntry({ status: "pending", permission: "auto-safe", params: { command: "npm install left-pad" } })] }, now: "2026-10-12T13:00:00.000Z" });
check("纯15：auto-safe + amber 命令（npm install）→ 自动过（risk=amber）",
	v10.due.length === 1 && v10.due[0].risk === "amber" && v10.due[0].why === "auto-safe:risk=amber");
const v11 = evaluateSchedule({ schedule: { entries: [pureEntry({ status: "pending", permission: "auto-safe", params: { command: "rm -rf /tmp/holdme" } })] }, now: "2026-10-12T13:00:00.000Z" });
check("纯16：auto-safe + red 命令（递归删除）→ 挂审批不 fire（risk=red）",
	v11.held.length === 1 && v11.held[0].why === "red-pending" && v11.held[0].risk === "red" && v11.due.length === 0);
// 11. no-ask：排好即生效
const v12 = evaluateSchedule({ schedule: { entries: [pureEntry({ status: "pending", permission: "no-ask" })] }, now: "2026-10-12T13:00:00.000Z" });
check("纯17：no-ask：pending 排好即生效 → due", v12.due.length === 1 && v12.due[0].why === "no-ask");
// 12. 档位优先级：entry.permission > 文件 default_permission > env > 默认
const v13a = evaluateSchedule({ schedule: { entries: [pureEntry({ status: "pending", permission: "always-ask" })], default_permission: "no-ask" }, now: "2026-10-12T13:00:00.000Z" });
check("纯18：条目级 permission 压过文件默认档（entry=always-ask file=no-ask → held）",
	v13a.held.length === 1 && v13a.held[0].tier === "always-ask");
const v13b = evaluateSchedule({ schedule: { entries: [pureEntry({ status: "pending", permission: undefined, params: { command: "npm install left-pad" } })], default_permission: "no-ask" }, envTier: "auto-safe", now: "2026-10-12T13:00:00.000Z" });
check("纯19：env 档压过文件默认档（env=auto-safe file=no-ask，amber 命令 → due，tierSource=env）",
	v13b.due.length === 1 && v13b.due[0].tierSource === "env" && v13b.due[0].tier === "auto-safe");
const v13c = evaluateSchedule({ schedule: { entries: [pureEntry({ status: "pending", permission: "no-ask" })] }, envTier: "always-ask", now: "2026-10-12T13:00:00.000Z" });
check("纯19b：条目级 permission 压过 env 档（entry=no-ask env=always-ask → due，链序 entry>env>file>default）",
	v13c.due.length === 1 && v13c.due[0].tierSource === "entry" && v13c.due[0].tier === "no-ask");
// 13. 坏形状条目不炸（纯函数不抛脏输入——同 retro-trigger 容错口径）
let v14 = null, threw14 = false;
try {
	v14 = evaluateSchedule({ schedule: { entries: [
		{ id: "b1", part: "wander" }, // window 缺失
		{ id: "b2", window: { start: "不是时间", end: "2026-10-12T14:00:00.000Z" }, part: "wander" }, // start 不可解析
		{ id: "b3", window: { start: "2026-10-12T14:00:00.000Z", end: "2026-10-12T12:00:00.000Z" }, part: "wander" }, // start 晚于 end
		{ id: "b4", window: NARROW }, // part 缺失
		"不是对象",
	] }, now: "2026-10-12T13:00:00.000Z" });
} catch (e) { threw14 = true; }
check("纯20：坏形状条目计入 ignored.invalid 不炸（5 条各带原因）",
	!threw14 && v14.ignored.invalid.length === 5 && v14.due.length === 0, `invalid=${v14?.ignored.invalid.length} threw=${threw14}`);
// 14. 终态/draft 忽略
const v15 = evaluateSchedule({ schedule: { entries: [
	pureEntry({ id: "t-fired", status: "fired" }), pureEntry({ id: "t-skip", status: "skipped" }),
	pureEntry({ id: "t-rej", status: "rejected" }), pureEntry({ id: "t-cxl", status: "cancelled" }),
	pureEntry({ id: "t-fail", status: "failed" }), pureEntry({ id: "t-draft", status: "draft" }),
] }, now: "2026-10-12T13:00:00.000Z" });
check("纯21：终态（fired/skipped/rejected/cancelled/failed）与 draft 不再消费",
	v15.ignored.terminal === 5 && v15.ignored.draft === 1 && v15.due.length === 0 && v15.skipped.length === 0 && v15.held.length === 0);
// 15. due 排序确定性（多条同燃按 window.start 升序——早窗先吃，不靠运气）
const v16 = evaluateSchedule({ schedule: { entries: [
	pureEntry({ id: "late", window: { start: "2026-10-12T12:30:00.000Z", end: "2026-10-12T14:00:00.000Z" } }),
	pureEntry({ id: "early", window: { start: "2026-10-12T12:00:00.000Z", end: "2026-10-12T14:00:00.000Z" } }),
] }, now: "2026-10-12T13:00:00.000Z" });
check("纯22：多条同燃 → due 按 window.start 升序（early 在前）", v16.due.length === 2 && v16.due[0].entry.id === "early");
// 16. 无命令面的条目 risk=silent（排班本身不是写操作——ACTION_RISK 表外=silent）
check("纯23：无 command 的条目 risk=silent（不在 ACTION_RISK 表）", scheduleEntryRisk({ part: "wander", params: {} }) === "silent");

// ============================================================================
// 二、存储面（data/schedule/schedule.json 读写 + 容错）
// ============================================================================
const storeDir = path.join(tmp, "store");
const sf = path.join(storeDir, "schedule.json");
// 17. 缺文件=空表（全新部署没排过日程是常态，不是错误）
check("存1：readSchedule 缺文件 → 空表（v1/always-ask/entries[]）",
	JSON.stringify(readSchedule(sf)) === JSON.stringify(emptySchedule()) && emptySchedule().default_permission === "always-ask");
// 18. roundtrip + 未知字段保留（前端可视化要吃的结构化数据不许被存储层削掉）
writeSchedule(sf, { v: 1, default_permission: "no-ask", entries: [makeEntry({ id: "s1", window: NARROW, part: "wander" })], future_viz_field: { a: 1 } });
const rr = readSchedule(sf);
check("存2：roundtrip 保字段（含未来可视化字段）",
	rr.default_permission === "no-ask" && rr.entries[0].id === "s1" && JSON.stringify(rr.future_viz_field) === JSON.stringify({ a: 1 }));
// 19. 坏 JSON=出声+空表（接缝不叠加崩）
fs.writeFileSync(sf, "{ 半截写入不是 JSON");
check("存3：坏 JSON → 空表不炸", Array.isArray(readSchedule(sf).entries) && readSchedule(sf).entries.length === 0);
// 20. 错过跳过持久化：盘上 status=skipped 后评估器不再重复报（终态）
writeSchedule(sf, { v: 1, entries: [Object.assign(makeEntry({ id: "s2", window: NARROW, part: "wander" }), { status: "skipped", skipped_at: "2026-10-12T14:01:00.000Z" })] });
const v20 = evaluateSchedule({ schedule: readSchedule(sf), now: "2026-10-12T15:00:00.000Z" });
check("存4：盘上 skipped 终态 → 评估器不再报 skipped（不重复跳过、不排队）",
	v20.skipped.length === 0 && v20.ignored.terminal === 1);
// 21. 活动窗文件读侧：缺/坏/好三态
const hf = path.join(storeDir, "active-hours.json");
check("存5：readActiveHoursFile 缺文件 → null", readActiveHoursFile(hf) === null);
fs.writeFileSync(hf, "{ 坏");
check("存6：readActiveHoursFile 坏 JSON → null", readActiveHoursFile(hf) === null);
fs.writeFileSync(hf, JSON.stringify({ activeHours: "11:00-13:00" }));
check("存7：readActiveHoursFile 好 JSON → activeHours 原文", readActiveHoursFile(hf) === "11:00-13:00");

// ============================================================================
// 三、消费接线回归（真跑 conductor --once；pi 替身 stub，零真钱）
// ============================================================================
const telDir = path.join(tmp, "telemetry");
fs.mkdirSync(telDir, { recursive: true });
// 遥测 fixture：陈旧事件（当日 JST 零消费——预算面干净；忙判由 CONDUCTOR_IDLE_NOW=1 跳过）
fs.writeFileSync(path.join(telDir, "pianist-wander-1-2026-10-11.jsonl"), [
	JSON.stringify({ v: 1, ts: "2026-10-11T00:00:00.000Z", agent: "pianist-wander-1", kind: "message_end", data: { usage: { cost: { total: 0.001 } } } }),
	"",
].join("\n"));
// hotspot 报告 fixture（generatedAt=now → 判新鲜不重扫）
const hotspotOut = path.join(tmp, "hotspots", "latest.json");
fs.mkdirSync(path.dirname(hotspotOut), { recursive: true });
fs.writeFileSync(hotspotOut, JSON.stringify({ v: 1, generatedAt: new Date().toISOString(), hotspots: [], errorHotspots: [] }));
// retro 状态 fixture（lastRetroAt=now → 冷却中不 spawn retropad）
const retroStateFile = path.join(tmp, "retro", "state.json");
fs.mkdirSync(path.dirname(retroStateFile), { recursive: true });
fs.writeFileSync(retroStateFile, JSON.stringify({ v: 1, lastRetroAt: new Date().toISOString(), runs: 1 }));

// pi 替身：argv 全量记账 + exit 0（CONDUCTOR_PI_BIN 只认 .js/.mjs 尾——同 retro-wire 方子）
const piStub = path.join(tmp, "pi-stub.mjs");
fs.writeFileSync(piStub, [
	'import fs from "node:fs";',
	'fs.appendFileSync(process.env.PI_STUB_LOG, JSON.stringify({ pid: process.pid, argv: process.argv.slice(2) }) + "\\n");',
	"process.exit(0);",
].join("\n"));

const marks = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : []);
const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const NOW0 = Date.now();
const winRel = (startMin, endMin) => ({ start: new Date(NOW0 + startMin * 60_000).toISOString(), end: new Date(NOW0 + endMin * 60_000).toISOString() });

function schedFileFor(name, entries, extra = {}) {
	const f = path.join(tmp, name, "schedule.json");
	fs.mkdirSync(path.dirname(f), { recursive: true });
	fs.writeFileSync(f, JSON.stringify({ v: 1, default_permission: "always-ask", entries, ...extra }, null, 2));
	return f;
}
function once({ dir, sched, args = ["--once"], tel = telDir, extraEnv = {} }) {
	const stateDir = path.join(dir, "state");
	fs.mkdirSync(stateDir, { recursive: true });
	return spawnSync(process.execPath, [CONDUCTOR, ...args], {
		env: {
			...CLEAN_ENV,
			CONDUCTOR_PARTS: "wander",
			CONDUCTOR_IDLE_NOW: "1",
			CONDUCTOR_STATE_DIR: stateDir,
			PIANIST_TELEMETRY_DIR: tel,
			CONDUCTOR_HOTSPOT_OUT: hotspotOut,
			CONDUCTOR_HOTSPOT_DIR: path.join(tmp, "no-such-dir"),
			CONDUCTOR_RETRO_STATE: retroStateFile,
			CONDUCTOR_PI_BIN: piStub,
			PIANIST_SHELL_URL: SHELL_URL,
			CONDUCTOR_SCHEDULE_FILE: sched,
			CONDUCTOR_ACTIVE_HOURS: "00:00-24:00", // 接线面钉全天窗：活动窗行为在纯函数面已覆盖，不赌真实钟点
			PI_STUB_LOG: path.join(dir, "pi-stub.log"),
			...extraEnv,
		},
		encoding: "utf8",
	});
}
const readSched = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const readState = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "state", "state.json"), "utf8"));

// ---- 场1：due approved 条目（always-ask 默认档+已审批）→ 判定行/到点行/拉起/记账/预算序 ----
// part=tideline-threads（函数牌面）：params=threads 数组原样透传进 prompt——「深耕线程 #33」端到端。
const dir1 = path.join(tmp, "w1");
const sched1 = schedFileFor("w1", [{
	id: "t1", window: winRel(-30, 60), part: "tideline-threads",
	params: [{ id: 33, weight: 0.9, unresolved: 1, status: "open", content: "深耕线程 #33：记忆线索探索" }],
	intent: "14:00-16:00 深耕线程 #33", created_by: "test", status: "approved",
}]);
const r1 = once({ dir: dir1, sched: sched1 });
const j1 = (r1.stdout.match(/\[conductor\] schedule 判定[^\n]*/) || ["(无判定行)"])[0];
check("接1：判定行 due=1（每 tick 出声——消费面三证之三）",
	r1.status === 0 && /schedule 判定：due=1 /.test(r1.stdout), j1.slice(0, 140));
check("接2：到点行出声（part/intent 可见）+ 拉起行 + 收工行",
	r1.stdout.includes("schedule 到点：#t1") && r1.stdout.includes("tideline-threads") && r1.stdout.includes("14:00-16:00 深耕线程 #33") && r1.stdout.includes("拉起 schedule #t1") && r1.stdout.includes("schedule #t1 tideline-threads 收工 exit=0"));
const fired1 = marks(path.join(dir1, "pi-stub.log"));
check("接3：schedule 拉起恰一场（pi 替身记账）", fired1.length === 1, `marks=${fired1.length}`);
const prompt1 = fired1.length ? fired1[fired1.length - 1] : "{}";
check("接4：参数透传端到端——prompt 里见 #33 牌面（params→牌面构造→pi argv）",
	fired1.length === 1 && JSON.parse(prompt1).argv.includes("-p") && /#33 w=0\.9/.test(String(JSON.parse(prompt1).argv.at(-1))) && /深耕线程 #33/.test(String(JSON.parse(prompt1).argv.at(-1))));
const s1 = readState(dir1);
const row1 = (s1.launches ?? []).find((l) => l.sched === "t1");
check("接5：launch 先写后做——行带 sched=t1、part、exit=0 回填",
	row1?.part === "tideline-threads" && row1?.exit === 0 && typeof row1?.ts === "string", JSON.stringify(row1));
check("接6：预算序——schedule 先吃：day.sched_fires=1 且 draws=0（骨头顶掉抽卡，余额下轮再看）",
	s1?.days?.[today]?.sched_fires === 1 && (s1?.days?.[today]?.draws ?? 0) === 0, JSON.stringify(s1?.days?.[today]));
const after1 = readSched(sched1).entries[0];
check("接7：条目落 status=fired + fired_at（盘上终态，重复消费由它挡）",
	after1.status === "fired" && typeof after1.fired_at === "string");
check("接8：last_schedule_fire 记账（--status 面可见的账）",
	s1.last_schedule_fire?.id === "t1" && s1.last_schedule_fire?.exit === 0 && s1.last_schedule_fire?.part === "tideline-threads");

// ---- 场2：--status 面带 lastScheduleFire（死活不用翻 journal 猜） ----
const r2 = spawnSync(process.execPath, [CONDUCTOR, "--status"], {
	env: { ...CLEAN_ENV, CONDUCTOR_STATE_DIR: path.join(dir1, "state"), PIANIST_TELEMETRY_DIR: telDir, PIANIST_SHELL_URL: SHELL_URL }, encoding: "utf8",
});
let st2 = null; try { st2 = JSON.parse(r2.stdout); } catch {}
check("接9：--status 带 lastScheduleFire（id/part/exit）", st2?.lastScheduleFire?.id === "t1" && st2?.lastScheduleFire?.part === "tideline-threads" && st2?.lastScheduleFire?.exit === 0, `id=${st2?.lastScheduleFire?.id}`);

// ---- 场3：阴性对照——清空 schedule.json → conductor tick 对 schedule 零触发（退化可证） ----
const dir3 = path.join(tmp, "w3");
const sched3 = schedFileFor("w3", []);
const r3 = once({ dir: dir3, sched: sched3 });
check("接10：空表零触发——判定行 due=0、无到点行、无 schedule 拉起；抽卡照常（肉照长）",
	r3.status === 0 && /schedule 判定：due=0 /.test(r3.stdout) && !r3.stdout.includes("schedule 到点") && !r3.stdout.includes("拉起 schedule")
	&& marks(path.join(dir3, "pi-stub.log")).length === 1 && readState(dir3)?.days?.[today]?.draws === 1,
	`marks=${marks(path.join(dir3, "pi-stub.log")).length}`);
const s3 = readState(dir3);
check("接11：空表时 launch 行不带 sched 字段（抽卡账与骨头账不混）", (s3.launches ?? []).every((l) => l.sched === undefined) && (s3.days?.[today]?.sched_fires ?? 0) === 0);

// ---- 场4：预算硬停也管骨头（单一入口①：预算全走既有闸） ----
const telBudget = path.join(tmp, "telemetry-budget");
fs.mkdirSync(telBudget, { recursive: true });
fs.writeFileSync(path.join(telBudget, "budget.jsonl"), [
	JSON.stringify({ v: 1, ts: new Date().toISOString(), agent: "x", kind: "message_end", data: { usage: { cost: { total: 5 } } } }),
	"",
].join("\n"));
const dir4 = path.join(tmp, "w4");
const r4 = once({ dir: dir4, sched: sched1, tel: telBudget }); // CLEAN_ENV 剥了 CONDUCTOR_DAILY_BUDGET → 默认 2 < 5
check("接12：预算硬停在 schedule 判定之前（烧完不拉新会话——骨头也不例外）",
	r4.status === 0 && r4.stdout.includes("预算硬停") && !r4.stdout.includes("schedule 判定") && marks(path.join(dir4, "pi-stub.log")).length === 0,
	(r4.stdout.match(/\[conductor\] 预算硬停[^\n]*/) || ["(无预算行)"])[0].slice(0, 100));

// ---- 场5：错过跳过落盘（LAST 时窗已过 → status=skipped 持久化；不排队不补跑） ----
const dir5 = path.join(tmp, "w5");
const sched5 = schedFileFor("w5", [{ id: "t5", window: winRel(-120, -60), part: "wander", params: {}, intent: "过期条目", created_by: "test", status: "pending", permission: "no-ask" }]);
const r5 = once({ dir: dir5, sched: sched5 });
const after5 = readSched(sched5).entries[0];
check("接13：错过跳过——skipped=1 行 + 盘上 status=skipped/skipped_at；错过不顶抽卡（draws=1）",
	r5.status === 0 && /schedule 判定：due=0 skipped=1 /.test(r5.stdout) && r5.stdout.includes("schedule 错过跳过：#t5") && after5.status === "skipped" && typeof after5.skipped_at === "string"
	&& readState(dir5)?.days?.[today]?.draws === 1, `status=${after5.status}`);
const r5b = once({ dir: dir5, sched: sched5 }); // 第二 tick：终态不再报
check("接14：第二 tick 终态不再报 skipped（skipped=0，不重复跳过）",
	r5b.status === 0 && /schedule 判定：due=0 skipped=0 /.test(r5b.stdout) && readSched(sched5).entries[0].status === "skipped");

// ---- 场6：held（always-ask 未审批）→ 汇总行出声、骨头不顶抽卡 ----
const dir6 = path.join(tmp, "w6");
const sched6 = schedFileFor("w6", [{ id: "t6", window: winRel(-30, 60), part: "wander", params: {}, intent: "待审批条目", created_by: "test", status: "pending" }]);
const r6 = once({ dir: dir6, sched: sched6 });
check("接15：pending 未审批 → 被闸拦汇总行（pending-approval）、无拉起、抽卡照常、盘上 status 不动",
	r6.status === 0 && r6.stdout.includes("schedule 窗口命中但被闸拦 1 条：#t6(pending-approval)") && !r6.stdout.includes("拉起 schedule")
	&& readState(dir6)?.days?.[today]?.draws === 1 && readSched(sched6).entries[0].status === "pending");

// ---- 场7：dry-run 只彩排——不 spawn 不落 status 不落 state ----
const dir7 = path.join(tmp, "w7");
const sched7 = schedFileFor("w7", [{ id: "t7", window: winRel(-30, 60), part: "wander", params: {}, intent: "彩排条目", created_by: "test", status: "approved" }]);
const r7 = once({ dir: dir7, sched: sched7, args: ["--once", "--dry-run"] });
check("接16：dry-run 彩排——判定行+将拉起行出、pi 零 spawn、schedule.json/state 不动",
	r7.status === 0 && /schedule 判定：due=1 /.test(r7.stdout) && r7.stdout.includes("[dry-run] schedule 将拉起") && marks(path.join(dir7, "pi-stub.log")).length === 0
	&& readSched(sched7).entries[0].status === "approved" && !fs.existsSync(path.join(dir7, "state", "state.json")));

// ---- 场8：part 不在牌池 → failed 落盘 + 抽卡照走（废骨头不拦肉） ----
const dir8 = path.join(tmp, "w8");
const sched8 = schedFileFor("w8", [{ id: "t8", window: winRel(-30, 60), part: "no-such-part", params: {}, intent: "野牌", created_by: "test", status: "approved" }]);
const r8 = once({ dir: dir8, sched: sched8 });
const after8 = readSched(sched8).entries[0];
check("接17：part 不在牌池 → 出声（warn 落 stderr）+status=failed（fail_reason 在场）+ 抽卡照常（draws=1）",
	r8.status === 0 && (r8.stdout + r8.stderr).includes("不在牌池") && after8.status === "failed" && String(after8.fail_reason ?? "").includes("不在牌池")
	&& readState(dir8)?.days?.[today]?.draws === 1, `status=${after8.status}`);

// ---- 场9：静态接线位——import 可 grep、消费缝在忙判之后抽卡之前（搬位置/注释掉即红） ----
const src = fs.readFileSync(CONDUCTOR, "utf8").replace(/\/\/[^\n]*/g, ""); // 剥行注释：注释掉的接线不算接线
const importIdx = src.indexOf('from "./schedule/index.mjs"');
const busyIdx = src.indexOf("if (idleMs <= IDLE_MS)");
const schedCallIdx = src.indexOf("await consumeSchedule(st, day, today)");
const drawIdx = src.indexOf("const part = drawPart(pool)");
check("接18：主循环 import schedule 评估器（grep 得见）", importIdx > 0, `import@${importIdx}`);
check("接19：消费缝在忙判之后、drawPart 抽卡之前（预算序的接线位）",
	busyIdx > 0 && schedCallIdx > busyIdx && drawIdx > schedCallIdx, `busy@${busyIdx} < sched@${schedCallIdx} < draw@${drawIdx}`);

// ---- 场10：data 文件在场（消费面三证之二：仓库种子落位） ----
const repoSched = JSON.parse(fs.readFileSync(path.join(CWD, "data", "schedule", "schedule.json"), "utf8"));
const repoHours = JSON.parse(fs.readFileSync(path.join(CWD, "data", "schedule", "active-hours.json"), "utf8"));
check("接20：仓库 data/schedule/ 两文件在场且形状对（schedule.json 空表种子 + active-hours 默认窗）",
	Array.isArray(repoSched.entries) && repoSched.default_permission === "always-ask" && repoHours.activeHours === "10:00-22:00");

console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
