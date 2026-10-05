// hotspot 心跳钉测试（2026-10-01 wander 认领 09-30 seed「发现闭环没有心跳」）：latest.json
// 只在有人记得时跑——停摆过五天（09-25→09-30，三场 spoor 重演无人抓）。心跳形状：
// 报告陈旧（默认 20h 窗）→ tick 顶部先扫后抽（预算硬停/忙判/冷却早退之前——心跳不属
// 抽卡账，纯机械零 LLM）；成功记账摘要（last_hotspot_scan，--status 面可见），失败挂
// 5min 重试冷却（报警不刷屏也不静默）；dry-run 只彩排不落盘。
// 测法：真跑 conductor --once（真扫描器、真落盘——都指 tmp），pi 替身 .mjs（exit 0）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const CWD = path.resolve(import.meta.dirname, "..");
const CONDUCTOR = path.join(CWD, "src", "conductor.mjs");
let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); }

// 密封底（10/5 体验反馈六号缝）：conductor 会话里跑测试，ambient CONDUCTOR_* 顺 process.env 漏给被测进程——
// 剥净起底 + 头顶灌假 ambient 自证（与 conductor-install-test 同款方子，密封再破自己的断言会叫）。
Object.assign(process.env, { CONDUCTOR_EVENT_TABLE: "ambient-seal-probe-not-real", CONDUCTOR_DAILY_BUDGET: "77", CONDUCTOR_SVPS_SSH: "ambient-seal-host-not-real", CONDUCTOR_SPOOR_FACE_COOLDOWN_H: "99" });
const CLEAN_ENV = { ...process.env };
for (const k of Object.keys(CLEAN_ENV)) if (/^CONDUCTOR_/.test(k)) delete CLEAN_ENV[k];


const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hotspot-heartbeat-"));
const stateDir = path.join(tmp, "state");
const telDir = path.join(tmp, "telemetry");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(telDir, { recursive: true });
const stateFile = path.join(stateDir, "state.json");
const out = path.join(tmp, "hotspots", "latest.json");
const st = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));

// fixture 遥测：几行真事件（扫描器零事件会自己出声——那是它的活，这里给正常面）
fs.writeFileSync(path.join(telDir, "pianist-wander-1-2026-10-01.jsonl"), [
	JSON.stringify({ v: 1, ts: "2026-10-01T00:00:00.000Z", agent: "pianist-wander-1", kind: "session_mark", data: {} }),
	JSON.stringify({ v: 1, ts: "2026-10-01T00:00:01.000Z", agent: "pianist-wander-1", kind: "tool_use", data: { tool: "bash", input: { command: "ls" }, isError: false } }),
	JSON.stringify({ v: 1, ts: "2026-10-01T00:00:02.000Z", agent: "pianist-wander-1", kind: "message_end", data: { usage: { totalTokens: 10, cost: { total: 0.001 } } } }),
	"",
].join("\n"));

// pi 替身：CONDUCTOR_PI_BIN 只认 .js/.mjs 尾，直跑 exit 0
const piStub = path.join(tmp, "pi-stub.mjs");
fs.writeFileSync(piStub, "process.exit(0);\n");

const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

function once(extra = {}, args = ["--once"]) {
	return spawnSync(process.execPath, [CONDUCTOR, ...args], {
		env: {
			...CLEAN_ENV,
			CONDUCTOR_PARTS: "wander",
			CONDUCTOR_IDLE_NOW: "1",
			CONDUCTOR_STATE_DIR: stateDir,
			PIANIST_TELEMETRY_DIR: telDir,
			CONDUCTOR_HOTSPOT_OUT: out,
			CONDUCTOR_PI_BIN: piStub,
			CONDUCTOR_DAILY_BUDGET: "999",
			...extra,
		},
		encoding: "utf8",
	});
}

// ---- 场1：报告缺失 → 心跳开扫（真扫描器真落盘），且不虚记抽卡账 ----
const r1 = once();
const s1 = st();
check("场1：心跳出声+扫描器真收工", r1.status === 0 && r1.stdout.includes("hotspot 心跳：") && r1.stdout.includes("hotspot 心跳收工"),
	(r1.stdout.match(/hotspot 心跳收工[^\n]*/) || ["(无收工行)"])[0].slice(0, 160));
let rep1 = null;
try { rep1 = JSON.parse(fs.readFileSync(out, "utf8")); } catch {}
check("场1：报告真落盘（v1，dir 指 fixture 遥测）", rep1?.v === 1 && rep1?.params?.dir === telDir, `eventsParsed=${rep1?.voice?.eventsParsed}`);
check("场1：记账（exit=0+热点数成对）", s1?.last_hotspot_scan?.exit === 0 && s1.last_hotspot_scan.hotspots === (rep1?.hotspots?.length ?? -1), `hotspots=${s1?.last_hotspot_scan?.hotspots}`);
check("场1：心跳不虚记抽卡账（draws=1/launches=1，与心跳无涉）", s1?.days?.[today]?.draws === 1 && s1.days[today]?.launches === 1 && s1.launches.length === 1,
	`draws=${s1?.days?.[today]?.draws} launches=${s1.launches.length}`);

// ---- 场2：报告新鲜（刚生成）→ 不扫不记（幂等呼吸，不是每 tick 空转） ----
const ts1 = s1.last_hotspot_scan.ts;
const r2 = once();
const s2 = st();
check("场2：新鲜报告不再扫（无心跳行，记账原样）", r2.status === 0 && !r2.stdout.includes("hotspot 心跳：") && s2.last_hotspot_scan.ts === ts1);

// ---- 场3：dry-run 只彩排——不落盘不改账 ----
const before3 = fs.readFileSync(out, "utf8");
const r3 = once({ CONDUCTOR_HOTSPOT_STALE_H: "0" }, ["--once", "--dry-run"]); // 0h 窗=强制陈旧
check("场3：dry-run 心跳彩排出声", r3.status === 0 && r3.stdout.includes("[dry-run] hotspot 心跳"),
	(r3.stdout.match(/\[dry-run\] hotspot[^\n]*/) || ["(无行)"])[0].slice(0, 160));
check("场3：彩排不动真报告（内容逐字未变）", fs.readFileSync(out, "utf8") === before3);

// ---- 场4：扫描器硬失败（dir 不可读 exit 1）→ 病名出声+5min 冷却；冷却内不重试，过期再战 ----
const failStateDir = path.join(tmp, "state-fail");
fs.mkdirSync(failStateDir, { recursive: true });
const failStateFile = path.join(failStateDir, "state.json");
const out4 = path.join(tmp, "hotspots-fail", "latest.json");
const onceFail = (extra = {}) => spawnSync(process.execPath, [CONDUCTOR, "--once"], {
	env: {
		...CLEAN_ENV,
		CONDUCTOR_PARTS: "wander",
		CONDUCTOR_IDLE_NOW: "1",
		CONDUCTOR_STATE_DIR: failStateDir,
		PIANIST_TELEMETRY_DIR: telDir,
		CONDUCTOR_HOTSPOT_DIR: path.join(tmp, "no-such-dir"),
		CONDUCTOR_HOTSPOT_OUT: out4,
		CONDUCTOR_PI_BIN: piStub,
		CONDUCTOR_DAILY_BUDGET: "999",
		...extra,
	},
	encoding: "utf8",
});
const r4 = onceFail();
const s4 = JSON.parse(fs.readFileSync(failStateFile, "utf8"));
check("场4：失败出声（心跳失败行带 exit）", r4.status === 0 && (r4.stdout + r4.stderr).includes("hotspot 心跳失败 exit=1"),
	((r4.stdout + r4.stderr).match(/hotspot 心跳失败[^\n]*/) || ["(无行)"])[0].slice(0, 160));
check("场4：失败记账+冷却挂上", s4.last_hotspot_scan.exit === 1 && typeof s4.hotspot_retry_after === "string" && Date.parse(s4.hotspot_retry_after) > Date.now(),
	`retry_after=${s4.hotspot_retry_after}`);
const r4b = onceFail();
check("场4b：冷却内不重试（无上膛行，ts 不动）", r4b.status === 0 && !r4b.stdout.includes("扫描器上膛") && JSON.parse(fs.readFileSync(failStateFile, "utf8")).last_hotspot_scan.ts === s4.last_hotspot_scan.ts);
const s4c = JSON.parse(fs.readFileSync(failStateFile, "utf8"));
s4c.hotspot_retry_after = new Date(Date.now() - 1000).toISOString(); // 冷却过期
fs.writeFileSync(failStateFile, JSON.stringify(s4c));
const r4c = onceFail();
check("场4c：冷却过期再战（上膛行回来）", r4c.status === 0 && r4c.stdout.includes("扫描器上膛"));

// ---- 场5：--status 面可见（心跳死活不用翻 journal 猜） ----
const r5 = spawnSync(process.execPath, [CONDUCTOR, "--status"], {
	env: { ...CLEAN_ENV, CONDUCTOR_STATE_DIR: failStateDir, PIANIST_TELEMETRY_DIR: telDir }, encoding: "utf8",
});
let st5 = null;
try { st5 = JSON.parse(r5.stdout); } catch {}
check("场5：--status 带 lastHotspotScan（失败面也可见）", st5?.lastHotspotScan?.exit === 1 && typeof st5.lastHotspotScan.ts === "string", `exit=${st5?.lastHotspotScan?.exit}`);

// ---- 场6：接线静态断言——心跳在预算/忙判早退之前（搬位置即报警） ----
const src = fs.readFileSync(CONDUCTOR, "utf8");
const hbIdx = src.indexOf("await heartbeatHotspotScan(st)");
const budgetIdx = src.indexOf("if (spend >= DAILY_BUDGET)");
const busyIdx = src.indexOf("if (idleMs <= IDLE_MS)");
check("场6：接线在一切早退之前（预算硬停/忙判之前）", hbIdx > 0 && budgetIdx > hbIdx && busyIdx > hbIdx,
	`hb@${hbIdx} < budget@${budgetIdx} < busy@${busyIdx}`);

console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
