// spoor-session 牌面指纹冷却钉测试（2026-09-30 wander）：09-30 凌晨验尸——当夜 spoor×3
// +todo-review 四场烧 ~$1.4 全在一张逐字没变的牌面上，三场 spoor 各自从零重演同一套探索、
// 得出同一句「够格值得动0」。冷却形状：上一场 spoor-session 正常收工（exit=0）记下的牌面
// 指纹（launch 行 faceHash）与本轮逐字相同且距今 < 冷却窗（默认 12h）→ 本轮不抽它；
// 牌面一字之变、冷却窗过期、上场非零退出、旧格式记录（无 faceHash）——四种情况资格立即恢复。
// 与 env-event 饿死退避同族但不同病：退避治「拉不到」，冷却治「拉到了但裁过了且没变」。
// 测法：真跑 conductor --once（非 dry——指纹要真落 launch 行），pi 替身 .mjs（exit 0），
// fixture workbench 走 CONDUCTOR_STIGMERGY_ROOT。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const CWD = path.resolve(import.meta.dirname, "..");
const CONDUCTOR = path.join(CWD, "src", "conductor.mjs");
let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spoor-face-cooldown-"));
const stateDir = path.join(tmp, "state");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(path.join(tmp, "telemetry"), { recursive: true });
const stateFile = path.join(stateDir, "state.json");
const st = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const drawLine = (s) => (s.match(/抽卡：[^\n]*/) || ["(无抽卡行)"])[0];

// fixture workbench：一个项目一张牌面
const wbRoot = path.join(tmp, "stig");
fs.mkdirSync(path.join(wbRoot, "workbench", "alpha"), { recursive: true });
const statusMd = path.join(wbRoot, "workbench", "alpha", "STATUS.md");
const writeBoard = (extra) => fs.writeFileSync(statusMd, [
	"# alpha", "", "## 下一步", "",
	"> 排序确认：2026-09-30（测试）·确认至第1条", "",
	"- T1 [the author] 测试条目｜出处：collab#100｜判据：npm test 全绿｜到期：2026-10-05",
	...(extra ? [extra] : []),
	"", "## 卡在哪", "", "- 无。",
].join("\n"));
writeBoard(null);

// pi 替身：CONDUCTOR_PI_BIN 只认 .js/.mjs 尾，直跑 exit 0
const piStub = path.join(tmp, "pi-stub.mjs");
fs.writeFileSync(piStub, "process.exit(0);\n");

const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

function once(extra = {}) {
	return spawnSync(process.execPath, [CONDUCTOR, "--once"], {
		env: {
			...process.env,
			CONDUCTOR_PARTS: "spoor-session",
			CONDUCTOR_IDLE_NOW: "1",
			CONDUCTOR_STATE_DIR: stateDir,
			PIANIST_TELEMETRY_DIR: path.join(tmp, "telemetry"),
			CONDUCTOR_STIGMERGY_ROOT: wbRoot,
			CONDUCTOR_PI_BIN: piStub,
			CONDUCTOR_DAILY_BUDGET: "999",
			CONDUCTOR_HOTSPOT_OUT: path.join(tmp, "hotspots", "latest.json"), // 隔离热点心跳（非 dry 的 --once 会真扫真落盘）
			...extra,
		},
		encoding: "utf8",
	});
}

// ---- 场1：首场真拉起——launch 行落牌面指纹 ----
const r1 = once();
const s1 = st();
const l1 = (s1.launches ?? []).at(-1);
check("场1：抽卡照走+真拉起（exit=0）", r1.status === 0 && r1.stdout.includes("抽卡：spoor-session") && r1.stdout.includes("牌面 够格1"),
	drawLine(r1.stdout).slice(0, 140));
check("场1：launch 行带 16 位 faceHash", l1?.part === "spoor-session" && /^[0-9a-f]{16}$/.test(l1?.faceHash ?? ""),
	`faceHash=${l1?.faceHash}`);
const hash1 = l1?.faceHash;

// ---- 场2：牌面逐字未变+冷却窗内 → 不抽不烧不虚记 ----
const r2 = once();
const s2 = st();
check("场2：指纹未变出声且本轮不抽", r2.status === 0 && r2.stdout.includes("牌面指纹未变") && r2.stdout.includes("本轮不抽") && !r2.stdout.includes("抽卡："),
	(r2.stdout.match(/牌面指纹未变[^\n]*/) || ["(无指纹行)"])[0].slice(0, 160));
check("场2：账没虚动（draws/launches 仍 场1 值）", s2.days[today]?.draws === 1 && s2.days[today]?.launches === 1 && s2.launches.length === 1,
	`draws=${s2.days[today]?.draws} launches=${s2.launches.length}`);

// ---- 场3：牌面一字之变（加一条）→ 资格立即恢复 ----
writeBoard("- T2 [the author] 第二条｜出处：collab#101｜判据：node --test 全过｜到期：2026-10-06");
const r3 = once();
const s3 = st();
const l3 = s3.launches.at(-1);
check("场3：牌面变了照抽（够格2）", r3.status === 0 && r3.stdout.includes("抽卡：spoor-session") && r3.stdout.includes("够格2"),
	drawLine(r3.stdout).slice(0, 140));
check("场3：新指纹 ≠ 旧指纹", l3?.faceHash && l3.faceHash !== hash1, `${hash1} → ${l3?.faceHash}`);

// ---- 场4：牌面没变但冷却窗为 0（时间维重探）→ 照抽 ----
const r4 = once({ CONDUCTOR_SPOOR_FACE_COOLDOWN_H: "0" });
check("场4：冷却窗过期照抽（时间维重探）", r4.status === 0 && r4.stdout.includes("抽卡：spoor-session") && !r4.stdout.includes("牌面指纹未变"),
	drawLine(r4.stdout).slice(0, 120));
check("场4：launches=3", st().launches.length === 3, `launches=${st().launches.length}`);

// ---- 场5：上场非零退出（没裁成）→ 不冷却 ----
// 注：反向找的是「最近一场同牌面且正常收工」的记录——若更早还有同牌面 exit=0 的裁过记录，
// 冷却仍成立（旧有效裁决不作废）。本场景只留一条死产记录，验证「死了的裁决不算裁过」。
const s5 = st();
const faceNow = s5.launches.at(-1)?.faceHash;
s5.launches = [{ day: today, part: "spoor-session", ts: new Date().toISOString(), exit: 1, events: null, faceHash: faceNow }];
fs.writeFileSync(stateFile, JSON.stringify(s5));
const r5 = once();
check("场5：上场 exit≠0 不冷却（死了的裁决不算裁过）", r5.status === 0 && r5.stdout.includes("抽卡：spoor-session"),
	drawLine(r5.stdout).slice(0, 120));

// ---- 场6：旧格式记录（无 faceHash）→ 不冷却不炸 ----
const s6 = st();
s6.launches = [{ day: today, part: "spoor-session", ts: new Date().toISOString(), exit: 0, events: null }];
fs.writeFileSync(stateFile, JSON.stringify(s6));
const r6 = once();
check("场6：无 faceHash 旧记录兼容（照抽）", r6.status === 0 && r6.stdout.includes("抽卡：spoor-session") && !r6.stdout.includes("牌面指纹未变"),
	drawLine(r6.stdout).slice(0, 120));

// ---- 场7：组合冷却——spoor 指纹未变 + env-event 退避 → 全池冷却，本轮不抽 ----
// 预挂 env-event 退避账（免三连红流程），再让 spoor 带新鲜同指纹记录
const s7 = JSON.parse(fs.readFileSync(stateFile, "utf8"));
s7.env_event_fail_streak = 3;
s7.env_event_backoff_day = today;
s7.env_event_backoff_table = "event-queue";
s7.launches = [{ day: today, part: "spoor-session", ts: new Date().toISOString(), exit: 0, events: null, faceHash: st().launches.at(-1)?.faceHash }];
fs.writeFileSync(stateFile, JSON.stringify(s7));
const beforeDraws = s7.days[today]?.draws ?? 0;
const r7 = spawnSync(process.execPath, [CONDUCTOR, "--once"], {
	env: {
		...process.env,
		CONDUCTOR_PARTS: "env-event,spoor-session",
		CONDUCTOR_IDLE_NOW: "1",
		CONDUCTOR_STATE_DIR: stateDir,
		PIANIST_TELEMETRY_DIR: path.join(tmp, "telemetry"),
		CONDUCTOR_STIGMERGY_ROOT: wbRoot,
		CONDUCTOR_PI_BIN: piStub,
		CONDUCTOR_DAILY_BUDGET: "999",
		CONDUCTOR_HOTSPOT_OUT: path.join(tmp, "hotspots", "latest.json"), // 隔离热点心跳（场7 非 dry）
	},
	encoding: "utf8",
});
const s7b = st();
check("场7：全池冷却出声且不抽卡", r7.status === 0 && r7.stdout.includes("牌面指纹未变") && r7.stdout.includes("可抽的牌全在冷却/退避") && !r7.stdout.includes("抽卡："),
	(r7.stdout.match(/可抽的牌[^\n]*/) || ["(无行)"])[0].slice(0, 140));
check("场7：draws 不虚记", (s7b.days[today]?.draws ?? 0) === beforeDraws, `draws=${s7b.days[today]?.draws}（场前 ${beforeDraws}）`);

console.log(`\n${pass}/${total} checks passed`);
process.exit(pass === total ? 0 : 1);
