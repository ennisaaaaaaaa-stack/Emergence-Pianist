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
	...process.env,
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

console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
