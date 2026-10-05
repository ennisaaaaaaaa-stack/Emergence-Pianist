// 引号嵌套坑钉测试（09-28 wander）：env-event 预取的 SQL 经 execFile→ssh→远端 shell 双层解析，
// q 里的 " 表名引号曾被外层双引号闭口吃掉——横杠表名剥引号=SQL语法错（09-28 00:14 journal 坐实：
// near "-": syntax error）。私有部署真名无横杠时症状隐形，f648274 的「空集干净」验证因此漏网。
// 测法：ssh 替身（CONDUCTOR_SSH_BIN）把远端命令串交给本地真 shell 真解析，db 指夹具 sqlite——
// 精确复刻双层引号环境。红绿两断言：未转义形状必须死（测试咬得住病），正组牌面出「2 条」。
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


const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "env-event-prefetch-"));
const DB = path.join(tmp, "mem.db");

// 夹具库：横杠表名（开源默认形状），3 行——2 行未回放应中，1 行已回放应滤（牌面=2 即 WHERE 真生效）
const schema = `CREATE TABLE "event-queue" (id INTEGER, thread_id INTEGER, cosine REAL, signal_text TEXT, signal_source TEXT, logged_at TEXT, replay_day TEXT);
INSERT INTO "event-queue" VALUES (7, 1, 0.5, 'row-seven', 'test', '2026-09-28T00:00:00Z', NULL);
INSERT INTO "event-queue" VALUES (8, 1, 0.5, 'row-eight-replayed', 'test', '2026-09-28T00:00:00Z', '2026-09-27');
INSERT INTO "event-queue" VALUES (9, 2, 0.7, 'row-nine', 'test', '2026-09-28T00:00:00Z', NULL);`;
const mk = spawnSync("sqlite3", [DB, schema], { encoding: "utf8" });
check("夹具库就位", mk.status === 0, (mk.stderr || "").trim().slice(0, 120));

// ssh 替身：$2=远端命令串。写死路径换夹具库后交本地 shell 真解析——
// 复刻「execFile 参数 → ssh 拼接 → 远端 shell 再解析」的双层引号环境
const stub = path.join(tmp, "ssh-stub");
fs.writeFileSync(stub, `#!/bin/sh
exec sh -c "$(printf '%s' "$2" | sed 's|~/memory/mcp_memory.db|${DB}|g')"
`);
fs.chmodSync(stub, 0o755);

// 对照组：未转义形状（f648274 病灶）走同一条链必须红——证明本测试咬得住这个病
const q = 'SELECT id, thread_id, cosine, signal_text, signal_source, logged_at FROM "event-queue" WHERE replay_day IS NULL AND id > 0 ORDER BY id ASC LIMIT 5';
const bad = spawnSync(stub, ["ignored-host", `sqlite3 -json ~/memory/mcp_memory.db "${q}"`], { encoding: "utf8" });
check("对照组：未转义形状死于引号被吃（syntax error）", bad.status !== 0 && /syntax error/.test(bad.stderr || ""), `exit=${bad.status} ${(bad.stderr || "").trim().split("\n")[0]}`);

// 正组：conductor --once --dry-run 强制 env-event——牌面行出「2 条（>0）」即引号活着送达
const env = {
	...CLEAN_ENV,
	CONDUCTOR_PARTS: "env-event",
	CONDUCTOR_IDLE_NOW: "1",
	CONDUCTOR_STATE_DIR: path.join(tmp, "state"),
	PIANIST_TELEMETRY_DIR: path.join(tmp, "telemetry"),
	CONDUCTOR_SSH_BIN: stub,
	CONDUCTOR_SVPS_SSH: "ignored-host",
	CONDUCTOR_DAILY_BUDGET: "999",
};
fs.mkdirSync(env.CONDUCTOR_STATE_DIR, { recursive: true });
fs.mkdirSync(env.PIANIST_TELEMETRY_DIR, { recursive: true });
const run = spawnSync(process.execPath, [CONDUCTOR, "--once", "--dry-run"], { env, encoding: "utf8" });
check("牌面 2 条（真 shell+真 sqlite 双层解析后活着回来；=2 而非 3 即已回放行被滤）",
	run.status === 0 && run.stdout.includes("牌面 2 条（>0）"),
	(run.stdout.match(/抽卡[^\n]*/) || ["(无抽卡行)"])[0].slice(0, 160));

// 边界：CONDUCTOR_MEMORY_DB 指夹具 + 替身 sed 无可换路径时仍工作（路径已被替换过一次也无害）
const run2 = spawnSync(process.execPath, [CONDUCTOR, "--once", "--dry-run"], {
	env: { ...env, CONDUCTOR_MEMORY_DB: DB }, encoding: "utf8",
});
check("CONDUCTOR_MEMORY_DB 缝生效（直接指夹具库也通）", run2.status === 0 && run2.stdout.includes("牌面 2 条（>0）"),
	(run2.stdout.match(/抽卡[^\n]*/) || ["(无抽卡行)"])[0].slice(0, 160));

// ---- prompt 分叉彩排（2026-10-01 wander，六场空牌猜动作名病历）：牌满/不可达/真空三分 ----
// 演练面断言（[env-event-prompt] 行）：不可达文案必须明说「不要去探队列」（探过的缝不在分身座位上），
// 真空文案必须明说「可达且无新事件」（不可达≠空）；纪律行必须明禁猜 pianist_bridge 动作名。
check("彩排A：满牌面——演练面含牌面行（thread/cos/摘录）与禁猜纪律",
	run.stdout.includes("[env-event-prompt]") && run.stdout.includes("- #1 cos=0.5 [test] row-seven")
		&& run.stdout.includes("不猜 pianist_bridge 的动作名"),
	run.stdout.split("\n").find((l) => l.includes("[env-event-prompt]")) ?? "(无彩排行)");

// 不可达：ssh 替身直接非零退出（复刻预取硬失败）——events=null 分支
const stubDead = path.join(tmp, "ssh-stub-dead");
fs.writeFileSync(stubDead, "#!/bin/sh\necho 'Error: no such table: event-queue' >&2\nexit 1\n");
fs.chmodSync(stubDead, 0o755);
const envDead = { ...env, CONDUCTOR_STATE_DIR: path.join(tmp, "state-dead"), CONDUCTOR_SSH_BIN: stubDead };
fs.mkdirSync(envDead.CONDUCTOR_STATE_DIR, { recursive: true });
const runDead = spawnSync(process.execPath, [CONDUCTOR, "--once", "--dry-run"], { env: envDead, encoding: "utf8" });
check("彩排B：不可达——降级文案明说「不要去探队列」+病名出声（no such table 指部署缝）",
	runDead.status === 0 && runDead.stdout.includes("牌面 预取失败降级")
		&& runDead.stdout.includes("不要去探队列") && runDead.stdout.includes("修因在部署侧"),
	runDead.stdout.split("\n").find((l) => l.includes("[env-event-prompt]")) ?? "(无彩排行)");

// 真空：夹具库只余已回放行——可达且无新事件分支（与不可达文案必须分叉，不能共用一句）
const DB_EMPTY = path.join(tmp, "empty.db");
const mkEmpty = spawnSync("sqlite3", [DB_EMPTY, `CREATE TABLE "event-queue" (id INTEGER, thread_id INTEGER, cosine REAL, signal_text TEXT, signal_source TEXT, logged_at TEXT, replay_day TEXT);
INSERT INTO "event-queue" VALUES (8, 1, 0.5, 'row-eight-replayed', 'test', '2026-09-28T00:00:00Z', '2026-09-27');`], { encoding: "utf8" });
check("真空夹具库就位", mkEmpty.status === 0, (mkEmpty.stderr || "").trim().slice(0, 120));
const envEmpty = { ...env, CONDUCTOR_STATE_DIR: path.join(tmp, "state-empty"), CONDUCTOR_MEMORY_DB: DB_EMPTY };
fs.mkdirSync(envEmpty.CONDUCTOR_STATE_DIR, { recursive: true });
const runEmpty = spawnSync(process.execPath, [CONDUCTOR, "--once", "--dry-run"], { env: envEmpty, encoding: "utf8" });
check("彩排C：真空——牌面 0 条 + 文案明说「可达且无新事件」（不可达≠空，两文案不共用）",
	runEmpty.status === 0 && runEmpty.stdout.includes("牌面 0 条（>0）")
		&& runEmpty.stdout.includes("队列可达且无新事件") && !runEmpty.stdout.includes("不要去探队列"),
	runEmpty.stdout.split("\n").find((l) => l.includes("[env-event-prompt]")) ?? "(无彩排行)");

// ---- 生产缝钉（2026-10-05 05:20 wander 补刀验尸）：真名注入 + 行内注释病 ----
// 当日生产事故形状：/etc/pianist/conductor.env 写 CONDUCTOR_EVENT_TABLE=event-queue  # 注释
// ——systemd EnvironmentFile 不剥行内 #，值连注释一起进 SQL → no such table，fetch 侧修因行
// 还会误导（缝写了，只是写歪）。两钉：①真名（无横杠）注入后全链路活 ②带注释值病名出声点名格式。
const DB_REAL = path.join(tmp, "real.db");
const mkReal = spawnSync("sqlite3", [DB_REAL, `CREATE TABLE "event-queue" (id INTEGER, thread_id INTEGER, cosine REAL, signal_text TEXT, signal_source TEXT, logged_at TEXT, replay_day TEXT);
INSERT INTO "event-queue" VALUES (11, 3, 0.9, 'real-row', 'user_message', '2026-10-05T00:00:00Z', NULL);`], { encoding: "utf8" });
check("真名夹具库就位（表名 event-queue，横杠形状加引号）", mkReal.status === 0, (mkReal.stderr || "").trim().slice(0, 120));
const envReal = { ...env, CONDUCTOR_STATE_DIR: path.join(tmp, "state-real"), CONDUCTOR_MEMORY_DB: DB_REAL, CONDUCTOR_EVENT_TABLE: "event-queue" };
fs.mkdirSync(envReal.CONDUCTOR_STATE_DIR, { recursive: true });
const runReal = spawnSync(process.execPath, [CONDUCTOR, "--once", "--dry-run"], { env: envReal, encoding: "utf8" });
check("真名注入：CONDUCTOR_EVENT_TABLE=event-queue 全链路活（牌面 1 条，摘录到场）",
	runReal.status === 0 && runReal.stdout.includes("牌面 1 条（>0）") && runReal.stdout.includes("real-row"),
	(runReal.stdout.match(/抽卡[^\n]*/) || ["(无抽卡行)"])[0].slice(0, 160));

// 病形状（复刻当日生产 env 原文）：值带行内注释——病名行必须点名「注释挪独立行」
const envBad = { ...env, CONDUCTOR_STATE_DIR: path.join(tmp, "state-bad"), CONDUCTOR_MEMORY_DB: DB_REAL,
	CONDUCTOR_EVENT_TABLE: "event-queue  # 2026-10-05 wander：远端实表已验" };
fs.mkdirSync(envBad.CONDUCTOR_STATE_DIR, { recursive: true });
const runBad = spawnSync(process.execPath, [CONDUCTOR, "--once", "--dry-run"], { env: envBad, encoding: "utf8" });
check("病形状出声：值带行内注释→病名行点名 EnvironmentFile 不剥 #（修法：注释挪独立行）",
	(runBad.stdout + runBad.stderr).includes("病名 env 值带行内注释/空白") && (runBad.stdout + runBad.stderr).includes("注释挪独立行"),
	(runBad.stdout + runBad.stderr).split("\n").find((l) => l.includes("病名 env 值")) ?? "(无病名行)");

console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
