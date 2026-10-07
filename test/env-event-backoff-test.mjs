// env-event 饿死退避钉测试（2026-09-29 wander）：09-28 深夜三连红的教训——预取硬失败
// （no such table）不因重试而愈，但 conductor 每个 30min 空闲窗都照抽 env-event 烧一场
// 空牌确认跑。退避形状：连续 N 次（默认 3）硬失败 → 当日(JST)停抽；表名缝一改自动解除
// 重探（修因在部署缝 CONDUCTOR_EVENT_TABLE，不在重试）。病名行必须出声说人话。
// 测法：真跑 conductor --once（非 dry——退避账要真落 state），ssh 替身两枚（坏=exit 1+
// no such table stderr；好=回 2 行 JSON），pi 替身 .mjs（CONDUCTOR_PI_BIN 只认 .js/.mjs 尾）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

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


const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "env-event-backoff-"));
const stateDir = path.join(tmp, "state");
fs.mkdirSync(stateDir, { recursive: true });
fs.mkdirSync(path.join(tmp, "telemetry"), { recursive: true });

// 坏 ssh 替身：复刻 no such table 的 stderr 尾行（真链路里它拼在 err.message 尾上）
const badSsh = path.join(tmp, "ssh-bad");
fs.writeFileSync(badSsh, `#!/bin/sh\necho 'Error: in prepare, no such table: event-queue' >&2\nexit 1\n`);
fs.chmodSync(badSsh, 0o755);
// 好 ssh 替身：预取成功形状——2 行已过 WHERE 的牌面
const okSsh = path.join(tmp, "ssh-ok");
fs.writeFileSync(okSsh, `#!/bin/sh\ncat <<'EOF'\n[{"id":7,"thread_id":1,"cosine":0.5,"signal_text":"row-seven","signal_source":"test","logged_at":"2026-09-29T00:00:00Z"},{"id":9,"thread_id":2,"cosine":0.7,"signal_text":"row-nine","signal_source":"test","logged_at":"2026-09-29T00:00:00Z"}]\nEOF\n`);
fs.chmodSync(okSsh, 0o755);
// pi 替身：.mjs 尾才被当入口直跑（CONDUCTOR_PI_BIN 契约）
const piStub = path.join(tmp, "pi-stub.mjs");
fs.writeFileSync(piStub, "process.exit(0);\n");

const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const stateFile = path.join(stateDir, "state.json");
const st = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
const drawLine = (s) => (s.match(/抽卡：[^\n]*/) || ["(无抽卡行)"])[0];

function once(sshBin, extra = {}) {
	return spawnSync(process.execPath, [CONDUCTOR, "--once"], {
		env: {
			...CLEAN_ENV,
			CONDUCTOR_PARTS: "env-event",
			CONDUCTOR_IDLE_NOW: "1",
			CONDUCTOR_STATE_DIR: stateDir,
			PIANIST_TELEMETRY_DIR: path.join(tmp, "telemetry"),
			CONDUCTOR_SSH_BIN: sshBin,
			CONDUCTOR_SVPS_SSH: "ignored-host",
			CONDUCTOR_PI_BIN: piStub,
			CONDUCTOR_DAILY_BUDGET: "999",
			CONDUCTOR_HOTSPOT_OUT: path.join(tmp, "hotspots", "latest.json"), // 隔离热点心跳（非 dry 的 --once 会真扫真落盘）
			...extra,
		},
		encoding: "utf8",
	});
}

// ---- 1-3 场：连续硬失败，计数爬升，第 3 场挂退避（该场照跑——已经拉了）----
for (let i = 1; i <= 3; i++) {
	const r = once(badSsh);
	const s = st();
	check(`第${i}场：抽卡照走+空牌降级出声`, r.status === 0 && r.stdout.includes("牌面 预取失败降级"),
		drawLine(r.stdout).slice(0, 140));
	// 病名行走 console.warn → stderr（出声不当 stdout 噪声）——两路合验
	check(`第${i}场：病名行说人话（指名 CONDUCTOR_EVENT_TABLE 缝）`,
		(r.stdout + r.stderr).includes("病名 no such table") && (r.stdout + r.stderr).includes("CONDUCTOR_EVENT_TABLE"),
		((r.stdout + r.stderr).match(/病名[^\n]*/) || ["(无病名行)"])[0].slice(0, 140));
	check(`第${i}场：fail_streak=${i}`, (s.env_event_fail_streak ?? 0) === i, `state=${s.env_event_fail_streak}`);
}
check("第3场后：退避已挂（day+表名成对记账）", st().env_event_backoff_day === today && st().env_event_backoff_table === "event-queue");
check("三场共 launches=3（阈值场照跑，停的是之后）", st().days[today]?.launches === 3 && st().launches.length === 3);

// ---- 第 4 场：退避生效——不抽不烧，draws 不虚记 ----
const r4 = once(badSsh);
check("第4场：退避出声且本轮不抽", r4.status === 0 && r4.stdout.includes("今日退避") && r4.stdout.includes("本轮不抽") && !r4.stdout.includes("抽卡："),
	(r4.stdout.match(/退避[^\n]*/) || ["(无退避行)"])[0].slice(0, 160));
check("第4场：账没虚动（draws/launches 仍 3）", st().days[today]?.draws === 3 && st().days[today]?.launches === 3 && st().launches.length === 3);

// ---- 第 5 场：修因（表名缝一改）→ 退避自动解除，牌面真回来 ----
const r5 = once(okSsh, { CONDUCTOR_EVENT_TABLE: "real-events" });
check("第5场：缝已改自动清退避重探", r5.status === 0 && r5.stdout.includes("退避缝已改") && r5.stdout.includes("抽卡：") && r5.stdout.includes("牌面 2 条"),
	drawLine(r5.stdout).slice(0, 140));
const s5 = st();
check("第5场：退避账清零+消费进度推进（last_env_event_id=9）",
	s5.env_event_fail_streak === 0 && s5.env_event_backoff_day === undefined && s5.env_event_backoff_table === undefined && s5.last_env_event_id === 9);

console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
