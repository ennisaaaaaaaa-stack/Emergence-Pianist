// 2026-09-29 wander 钉：换防清道夫正典件——探针必须是 cgroup.procs 对照 MainPID。
// 病史：pi 启动后把 argv 改写成 'pi'，手搓版拿 pgrep -f 'cli\.js -p' 当探针 → 20s 确认窗
// 全瞎两读 → 00:28:34 把正写收尾报告的 wander 杀了（WANDER-OPS/遥测尾批/launch 记录三失）。
// 覆盖：语法 / 探针纪律静态钉（不许再出现 pgrep）/ 判闲-确认-补刀 / 忙不误收 /
//       读数失败按忙 / 忙转闲可恢复（补刀发生在退役之后，不在上岗之时）。
// 不动真系统：CGROUP_PROCS 指 tmp 夹具，SYSTEMCTL 指 stub（show 出固定 MainPID，restart 落日志）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync, spawn } from "node:child_process";

const CWD = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(CWD, "deploy", "rearm-conductor.sh");
let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); }

// ---- 1. 语法 + 探针纪律静态钉 ----
check("语法：sh -n 通过", spawnSync("sh", ["-n", SCRIPT]).status === 0);
const src = fs.readFileSync(SCRIPT, "utf8");
const codeOnly = src.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"); // 注释保留病史，钉子钉的是代码面
check("探针纪律：读 cgroup.procs 对照 systemctl MainPID", /cgroup\.procs/.test(codeOnly) && /MainPID/.test(codeOnly));
check("探针纪律：代码面无 pgrep（pi 把 argv 改写成 'pi'——pgrep -f cli.js 是瞎的，这是 09-29 00:28 误杀的病根）", !/pgrep/.test(codeOnly));
check("判据方向：读数异常按忙（is_idle 里读不到就 return 1，只会晚收不会误收）", /is_idle\(\)\s*\{[\s\S]*?return 1[\s\S]*?return 1[\s\S]*?\}/.test(src));

// ---- 2. 沙盒件：stub systemctl + cgroup.procs 夹具 ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rearm-conductor-test-"));
const procsFile = path.join(tmp, "cgroup.procs");
const stubLog = path.join(tmp, "systemctl.log");
const stub = path.join(tmp, "systemctl-stub.sh");
fs.writeFileSync(stub, [
	"#!/bin/sh",
	'echo "$@" >> "$STUB_LOG"',
	'if [ "$1" = "show" ]; then echo "$STUB_MAINPID"; fi',
	"exit 0",
].join("\n"));
fs.chmodSync(stub, 0o755);
const MAINPID = "4242";
function baseEnv(extraSecs) {
	return {
		...process.env,
		REARM_UNIT: "pianist-conductor",
		REARM_CGROUP_PROCS: procsFile,
		REARM_SYSTEMCTL: stub,
		STUB_LOG: stubLog,
		STUB_MAINPID: MAINPID,
		REARM_CONFIRM_SECS: "1",
		REARM_POLL_SECS: "1",
		...extraSecs,
	};
}
function writeProcs(pids) { fs.writeFileSync(procsFile, pids.join("\n") + "\n"); }
function stubCalls() { return fs.existsSync(stubLog) ? fs.readFileSync(stubLog, "utf8") : ""; }

// ---- 3. 判闲 → 确认窗两读 → 补刀 restart ----
writeProcs([Number(MAINPID)]); // 只剩主进程 = 值班者已退役
const fire = spawnSync("sh", [SCRIPT], { env: baseEnv({ REARM_TOTAL_SECS: "15" }), encoding: "utf8", timeout: 20000 });
check("退役后补刀：exit=0 且真调了 restart pianist-conductor", fire.status === 0 && stubCalls().includes("restart pianist-conductor"),
	((fire.stdout || "") + (fire.stderr || "")).trim().slice(0, 200));
check("退役后补刀：出声含确认窗与补刀行（不静默）", (fire.stdout || "").includes("确认窗") && (fire.stdout || "").includes("补刀"));
check("退役后补刀：show 探针在用（stub 收到过 MainPID 查询）", stubCalls().includes("show pianist-conductor"));

// ---- 4. 忙不误收：cgroup 里有别的 PID → 到死不 restart ----
fs.rmSync(stubLog, { force: true });
writeProcs([Number(MAINPID), 99999]); // 99999 = 活着的 pi session（argv 已改成 'pi'，pgrep 看不见它）
const busy = spawnSync("sh", [SCRIPT], { env: baseEnv({ REARM_TOTAL_SECS: "3" }), encoding: "utf8", timeout: 20000 });
check("忙不误收：超时自灭 exit≠0 且从未 restart", busy.status !== 0 && !stubCalls().includes("restart"),
	`status=${busy.status} log=${JSON.stringify(stubCalls())}`);
check("忙不误收：出声说还有值班进程 + 总超时（不装死）", (busy.stdout || "").includes("值班进程") && (busy.stdout || "").includes("总超时"));

// ---- 5. 读数失败按忙：cgroup.procs 读不到 → 宁可超时也不动手 ----
fs.rmSync(stubLog, { force: true });
fs.rmSync(procsFile, { force: true }); // unit 不在/cgroup 未挂载等异常形状
const blind = spawnSync("sh", [SCRIPT], { env: baseEnv({ REARM_TOTAL_SECS: "2" }), encoding: "utf8", timeout: 20000 });
check("读数失败=忙：不 restart、超时自灭（瞎的时候不许开枪）", blind.status !== 0 && !stubCalls().includes("restart"));

// ---- 6. 忙转闲可恢复：补刀发生在退役之后，不在上岗之时 ----
fs.rmSync(stubLog, { force: true });
writeProcs([Number(MAINPID), 99999]); // 起步忙
const child = spawn("sh", [SCRIPT], { env: baseEnv({ REARM_TOTAL_SECS: "15" }), stdio: ["ignore", "pipe", "pipe"] });
let out = "";
child.stdout.on("data", (d) => { out += d.toString(); });
const lateTimer = setTimeout(() => writeProcs([Number(MAINPID)]), 1500); // 1.5s 后值班者退役
const code = await new Promise((resolve) => { child.on("close", resolve); });
clearTimeout(lateTimer);
check("忙转闲：退役后才补刀（exit=0 + restart 且发生在改夹具之后）",
	code === 0 && stubCalls().includes("restart pianist-conductor") && (out.includes("值班进程") && out.includes("补刀")),
	`code=${code} out=${out.trim().slice(0, 160)}`);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass}/${total} passed`);
process.exit(pass === total ? 0 : 1);
