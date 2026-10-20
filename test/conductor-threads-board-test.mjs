// tideline-threads 牌面排序与限额测试（2026-10-12 dualcard 交付二）：fetchThreadsBoard 的 SQL
// 钉死两条——ORDER BY weight DESC（牌面按权重降序， hottest 线头先进）与 LIMIT 10（一场线索
// 探索吃得下十根线头，不是全库）。测法：夹具 11 行 weight 与 id/插入序都错开（排序真生效的
// 形状——weight 序≠id 序），dry-run 彩排面逐行断言（[tideline-threads-prompt] 行序即牌面序，
// 不翻源码）。突变自测位：LIMIT 改 3 → 11 进 10 出这条红；ORDER BY 删掉 → 序列断言红。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

// T16 凭证记账隔离（同款方子）：dry-run 不 spawn pi，但密封底先立——本仓测试纪律
const __credTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pianist-cred-seal-"));
process.env.PORTALK_CRED_DIR = path.join(__credTmp, "cred");
process.env.PORTALK_CRED_JOURNAL = path.join(__credTmp, "journal.jsonl");

const CWD = path.resolve(import.meta.dirname, "..");
const CONDUCTOR = path.join(CWD, "src", "conductor.mjs");
let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); }

// 密封底（同款方子）：ambient CONDUCTOR_* 剥净起底 + 头顶灌假 ambient 自证
Object.assign(process.env, { CONDUCTOR_TIDELINE_DB: "/ambient-seal-tide-not-real.db", CONDUCTOR_EVENT_TABLE: "ambient-seal-probe-not-real", CONDUCTOR_DAILY_BUDGET: "77" });
const CLEAN_ENV = { ...process.env };
for (const k of Object.keys(CLEAN_ENV)) if (/^CONDUCTOR_/.test(k)) delete CLEAN_ENV[k];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-threads-board-"));
const telDir = path.join(tmp, "telemetry");
fs.mkdirSync(telDir, { recursive: true });
const stateDir = path.join(tmp, "state");
fs.mkdirSync(stateDir, { recursive: true });

// 夹具：11 行，weight 与 id 序/插入序都错开（weight DESC ≠ id ASC——排序真生效才咬得住）
// 预期牌面序（weight DESC 前 10）：2(0.11) 6(0.10) 4(0.09) 10(0.08) 8(0.07) 11(0.06) 3(0.05) 7(0.04) 9(0.03) 1(0.02)；5(0.01) 被 LIMIT 裁掉
const tideDb = path.join(tmp, "tideline-11.db");
const mk = spawnSync("sqlite3", [tideDb, `CREATE TABLE threads (id INTEGER PRIMARY KEY, content TEXT, status TEXT, importance REAL, unresolved REAL, weight REAL);
INSERT INTO threads VALUES (1, '线索-id1-w002', 'open', 0.2, 0.2, 0.02),
 (2, '线索-id2-w011', 'open', 0.9, 0.9, 0.11),
 (3, '线索-id3-w005', 'open', 0.5, 0.5, 0.05),
 (4, '线索-id4-w009', 'open', 0.8, 0.8, 0.09),
 (5, '线索-id5-w001', 'open', 0.1, 0.1, 0.01),
 (6, '线索-id6-w010', 'open', 0.85, 0.85, 0.10),
 (7, '线索-id7-w004', 'open', 0.4, 0.4, 0.04),
 (8, '线索-id8-w007', 'open', 0.7, 0.7, 0.07),
 (9, '线索-id9-w003', 'open', 0.3, 0.3, 0.03),
 (10, '线索-id10-w008', 'open', 0.75, 0.75, 0.08),
 (11, '线索-id11-w006', 'open', 0.6, 0.6, 0.06);`], { encoding: "utf8" });
check("夹具：11 行就位（weight 与 id 序错开，importance/unresolved/weight 三列齐）", mk.status === 0, (mk.stderr || "").trim().slice(0, 120));

const r = spawnSync(process.execPath, [CONDUCTOR, "--once", "--dry-run"], {
	env: {
		...CLEAN_ENV,
		CONDUCTOR_PARTS: "tideline-threads",
		CONDUCTOR_IDLE_NOW: "1",
		CONDUCTOR_STATE_DIR: stateDir,
		PIANIST_TELEMETRY_DIR: telDir,
		CONDUCTOR_TIDELINE_DB: tideDb,
		CONDUCTOR_DAILY_BUDGET: "999",
	},
	encoding: "utf8", timeout: 60_000,
});

// 彩排面线头行：`[tideline-threads-prompt] - #<id> w=<weight> 未解=<n> [status] 内容`——行序即牌面序
const ids = (r.stdout.match(/^\[tideline-threads-prompt\] - #\d+ w=/gm) || [])
	.map((l) => Number(l.match(/#(\d+)/)[1]));
const expectOrder = [2, 6, 4, 10, 8, 11, 3, 7, 9, 1];
check("排序按 weight DESC：牌面行序=预期（hottest 先进，weight 序≠id 序——ORDER BY 真生效）",
	r.status === 0 && JSON.stringify(ids) === JSON.stringify(expectOrder), `ids=${JSON.stringify(ids)}`);
check("LIMIT 10 钉死：11 行进 10 出（第 11 名 w=0.01 不进牌面）",
	ids.length === 10 && !ids.includes(5), `n=${ids.length}`);
check("牌面行带权重与未解度（w=/未解= 形状，分身可按热度挑线）",
	r.stdout.includes("w=0.11") && r.stdout.includes("未解=0.9") && r.stdout.includes("线索-id2-w011"));
check("牌面行出「11 条线索」的账面对不上——牌面行只报进榜数（10）",
	r.stdout.includes("牌面 10 条线索") && !r.stdout.includes("牌面 11 条线索"),
	(r.stdout.match(/抽卡：[^\n]*/) || ["(无抽卡行)"])[0].slice(0, 160));

console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
