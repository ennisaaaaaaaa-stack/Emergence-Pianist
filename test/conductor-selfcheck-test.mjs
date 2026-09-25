// seed① 测试：conductor 正典自检——残骸 unit 运行时存活性这半的钉。
// 不碰真系统：cgroup 样本走 --cgroup-file 指向 tmp 夹具；systemctl 走 CONDUCTOR_SYSTEMCTL 指向 stub。
// 断言四态：异名残骸拒、正典未 enable 拒、非 systemd 托管免检、正典在位通过；外加 systemctl 缺席放行。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const CWD = path.resolve(import.meta.dirname, "..");
const CONDUCTOR = path.join(CWD, "src", "conductor.mjs");
let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-selfcheck-"));

// cgroup 夹具（v2 单行 / v1 多行 / 无 .service——systemd-run 的 .scope 形状）
fs.writeFileSync(path.join(tmp, "cg-canonical"), "0::/system.slice/pianist-conductor.service\n");
fs.writeFileSync(path.join(tmp, "cg-alien"), "0::/system.slice/portalk-conductor.service\n");
fs.writeFileSync(path.join(tmp, "cg-scope"), "0::/system.slice/portalk-conductor.service/portalk-conductor-reap.service/some.scope\n");
fs.writeFileSync(path.join(tmp, "cg-none"), "0::/user.slice/user-0.slice/session-12.scope\n");
fs.writeFileSync(path.join(tmp, "cg-v1"), "10:devices:/system.slice/pianist-conductor.service\n0::/\n"); // v1 双行也认正身

// systemctl stub：exit 0=enabled / exit 1=disabled / 不存在=工具缺席
fs.writeFileSync(path.join(tmp, "sc-ok"), `#!/bin/sh\nexit 0\n`);
fs.writeFileSync(path.join(tmp, "sc-no"), `#!/bin/sh\nexit 1\n`);
fs.chmodSync(path.join(tmp, "sc-ok"), 0o755);
fs.chmodSync(path.join(tmp, "sc-no"), 0o755);

function run(cgroupFile, systemctl) {
	const env = { ...process.env };
	if (systemctl) env.CONDUCTOR_SYSTEMCTL = systemctl;
	const r = spawnSync(process.execPath, [CONDUCTOR, "--self-check", "--cgroup-file", cgroupFile], { env, encoding: "utf8" });
	return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

// ---- 四态 + 缺席放行 ----
let r = run(path.join(tmp, "cg-canonical"), path.join(tmp, "sc-ok"));
check("正典+enabled → exit 0 且理由=正典在位", r.code === 0 && r.out.includes("正典在位"), r.out.trim().slice(0, 120));

r = run(path.join(tmp, "cg-alien"), path.join(tmp, "sc-ok"));
check("异名残骸 → exit 1 且指名残骸形状", r.code === 1 && r.out.includes("异名同源残骸") && r.out.includes("portalk-conductor.service"), r.out.trim().slice(0, 120));

r = run(path.join(tmp, "cg-canonical"), path.join(tmp, "sc-no"));
check("正典+disabled → exit 1（disable 后的运行时残留也挡）", r.code === 1 && r.out.includes("运行时残留"), r.out.trim().slice(0, 120));

r = run(path.join(tmp, "cg-none"), path.join(tmp, "sc-ok"));
check("非 systemd unit（session scope/手动跑）→ 免检 exit 0", r.code === 0 && r.out.includes("免检"), r.out.trim().slice(0, 120));

r = run(path.join(tmp, "cg-canonical"), path.join(tmp, "sc-missing-no-such-file"));
check("systemctl 缺席 → 证据不足放行 exit 0（不凭缺席挡门）", r.code === 0 && r.out.includes("证据不足"), r.out.trim().slice(0, 120));

r = run(path.join(tmp, "cg-scope"), path.join(tmp, "sc-ok"));
check("嵌在异名 service 树下的会话 → 拒（它就是残骸家里的孩子，v1 钉如实拒不装看不见）", r.code === 1 && r.out.includes("异名同源残骸"), r.out.trim().slice(0, 120));

r = run(path.join(tmp, "cg-v1"), path.join(tmp, "sc-ok"));
check("cgroup v1 多行 → 认出正身通过", r.code === 0 && r.out.includes("正典在位"), r.out.trim().slice(0, 120));

// ---- 常驻分支接线（静态断言：门必须在常驻分支，--once/--dry-run/--status 不设卡）----
const src = fs.readFileSync(CONDUCTOR, "utf8");
const onceIdx = src.indexOf("if (ONCE) { await tick(); return; }");
const gateIdx = src.indexOf('if (process.env.CONDUCTOR_SKIP_UNIT_CHECK !== "1") {');
check("接线：自检门在 --once 早退之后、常驻循环之前（彩排/运维面不设卡）",
	onceIdx !== -1 && gateIdx !== -1 && onceIdx < gateIdx, `once@${onceIdx} gate@${gateIdx}`);
check("接线：CONDUCTOR_SKIP_UNIT_CHECK 豁免开关存在（例外须显式起草）", src.includes('process.env.CONDUCTOR_SKIP_UNIT_CHECK !== "1"'));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
