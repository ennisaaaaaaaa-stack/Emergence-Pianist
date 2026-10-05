// 施工③第二铲测试：conductor 常驻化安装件——不依赖真装。
// 覆盖：systemd-analyze verify unit 语法、install 脚本 dry-run / 缺 key 出声 / tmp 沙盒真跑、.gitignore 防呆。
// 不碰真系统：verify 只读；install 真跑用 CONDUCTOR_* 覆写把 env/unit/systemctl 全部指到 tmp。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const CWD = path.resolve(import.meta.dirname, "..");
const UNIT = path.join(CWD, "deploy", "pianist-conductor.service");
const INSTALL = path.join(CWD, "deploy", "install-conductor.sh");
// T15 活一（2026-10-05）：install 会探真机钥匙柜（柜有 coding-plan → 不写 key 行）。
// 全文件统一隔离到空柜——所有既有断言保持「过渡态」语义；柜分支专项断言在 5d。
const emptyCredDir = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-install-emptycred-"));
process.env.PORTALK_CRED_DIR = emptyCredDir;
let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); }


// ---- 0. 密封底（2026-10-05，体验反馈六号缝）：conductor 会话里跑测试，ambient CONDUCTOR_* 顺 process.env 漏给被测进程 ----
// 病例：ambient CONDUCTOR_EVENT_TABLE 让「表名缝」两断言假红（外部突变复现过）；5c 段早有剥净先例但只钉了一段=钉子钉半根。
// 方子：全文件统一 CLEAN_ENV 起底；头顶故意灌假 ambient——整套测试从此跑在污染环境里，密封再破自己的断言会叫。
Object.assign(process.env, { CONDUCTOR_EVENT_TABLE: "ambient-seal-probe-not-real", CONDUCTOR_DAILY_BUDGET: "77", CONDUCTOR_SVPS_SSH: "ambient-seal-host-not-real", CONDUCTOR_SPOOR_FACE_COOLDOWN_H: "99" });
const CLEAN_ENV = { ...process.env };
for (const k of Object.keys(CLEAN_ENV)) if (/^CONDUCTOR_/.test(k)) delete CLEAN_ENV[k];
check("密封：头顶灌假 ambient 后 CLEAN_ENV 剥净一个不剩（破封即红）", !Object.keys(CLEAN_ENV).some((k) => /^CONDUCTOR_/.test(k)) && process.env.CONDUCTOR_EVENT_TABLE === "ambient-seal-probe-not-real");

const unit = fs.readFileSync(UNIT, "utf8");

// ---- 1. unit 关键字段：重启姿势 / 依赖序 / env 在 repo 外 / 无 key ----
check("unit：After=network.target（照 tideline 先例）", /^After=network\.target$/m.test(unit));
check("unit：Restart=on-failure + RestartSec 有值", /^Restart=on-failure$/m.test(unit) && /^RestartSec=\d+$/m.test(unit));
check("unit：EnvironmentFile 指向 /etc/pianist/conductor.env（repo 外）", /^EnvironmentFile=\/etc\/pianist\/conductor\.env$/m.test(unit));
check("unit：不含任何 key 名/值（连名字都不该出现，注入只走 EnvironmentFile）", !/ZAI|API_KEY|TOKEN|SECRET|sk-|Bearer/i.test(unit));

// ---- 2. systemd-analyze verify（只读语法校验；env 文件此时可以不存在——verify 不查其存在性） ----
// 模板占位符先展开再 verify（systemd 要求绝对路径；真实路径由 install 脚本展开）
const unitExpanded = unit.replaceAll("__REPO_HOME__", CWD).replaceAll("__NODE_BIN__", spawnSync("bash", ["-c", "command -v node"], { encoding: "utf8" }).stdout.trim());
const tmpUnitVerify = path.join(os.tmpdir(), "pianist-conductor-verify.service");
fs.writeFileSync(tmpUnitVerify, unitExpanded);
const ver = spawnSync("systemd-analyze", ["verify", tmpUnitVerify], { encoding: "utf8" });
fs.rmSync(tmpUnitVerify, { force: true });
check("systemd-analyze verify 通过（exit=0）", ver.status === 0, ((ver.stdout || "") + (ver.stderr || "")).trim().slice(0, 200));

// ---- 3. install 脚本：bash -n 语法 + 缺 key 大声死（不装哑巴） ----
check("install：bash -n 语法通过", spawnSync("bash", ["-n", INSTALL]).status === 0);
const noKeyEnv = { ...CLEAN_ENV };
delete noKeyEnv.ZAI_CODING_CN_API_KEY;
const noKey = spawnSync("bash", [INSTALL, "--dry-run"], { env: noKeyEnv, encoding: "utf8" });
check("install：缺 ZAI_CODING_CN_API_KEY → 非零退出 + stderr 出声", noKey.status !== 0 && (noKey.stderr || "").includes("不静默") && (noKey.stderr || "").includes("ZAI_CODING_CN_API_KEY"));

// ---- 4. dry-run：只打印不动系统（旁路目标指 tmp，断言 tmp 无副作用即证明没写） ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-install-test-"));
const tmpEnv = path.join(tmp, "pianist", "conductor.env");
const tmpUnitDir = path.join(tmp, "systemd");
const over = { ...CLEAN_ENV, ZAI_CODING_CN_API_KEY: "test-dummy-key-not-real", CONDUCTOR_ENV_FILE: tmpEnv, CONDUCTOR_UNIT_DEST: tmpUnitDir, CONDUCTOR_SYSTEMCTL: ":" };
const dry = spawnSync("bash", [INSTALL, "--dry-run"], { env: over, encoding: "utf8" });
check("dry-run：exit=0 且打印计划（含 [dry-run] 标记与 600 权限声明）", dry.status === 0 && dry.stdout.includes("[dry-run]") && dry.stdout.includes("600"));
check("dry-run：不动系统——env/unit 目标均未创建", !fs.existsSync(tmpEnv) && !fs.existsSync(tmpUnitDir));

// ---- 5. tmp 沙盒真跑（SYSTEMCTL=: 吞掉 systemctl 步骤）：文件落地 + 权限 + key 不进 unit ----
// （柜隔离已在文件头统一：PORTALK_CRED_DIR 指空柜——本节断言全部是「过渡态」语义）
const real = spawnSync("bash", [INSTALL], { env: over, encoding: "utf8" });
const envOk = real.status === 0 && fs.existsSync(tmpEnv) && fs.existsSync(path.join(tmpUnitDir, "pianist-conductor.service")) && fs.existsSync(path.join(tmpUnitDir, "pianist-shell.service"));
check("真跑（旁路 tmp）：exit=0，env+unit 落地", envOk, (real.stderr || "").trim().slice(0, 200));
check("真跑（旁路 tmp）：env 文件含 key 且权限 600（创建即 600，无中间态）",
	envOk && fs.readFileSync(tmpEnv, "utf8").includes("ZAI_CODING_CN_API_KEY=test-dummy-key-not-real") && (fs.statSync(tmpEnv).mode & 0o777) === 0o600,
	`mode=${(fs.statSync(tmpEnv).mode & 0o777).toString(8)}`);
const landed = envOk ? fs.readFileSync(path.join(tmpUnitDir, "pianist-conductor.service"), "utf8") : "";
check("真跑（旁路 tmp）：落地 unit 是模板展开结果（占位符已替换，key 不可能混进去）",
	envOk && landed === unit
		.replaceAll("__REPO_HOME__", path.resolve(CWD))
		.replaceAll("__NODE_BIN__", spawnSync("bash", ["-c", "command -v node"], { encoding: "utf8" }).stdout.trim())
	&& !landed.includes("ZAI"));
const again = spawnSync("bash", [INSTALL], { env: over, encoding: "utf8" });
check("幂等：同参数二跑 exit=0 不炸", again.status === 0, (again.stderr || "").trim().slice(0, 200));

// ---- 5b. 表名缝（2026-09-29 wander）：无值时落注释行提示；有值时保全不因重装蒸发 ----
check("表名缝：无值时 env 落注释行（装时看得见，出病时搜得到）",
	envOk && /^# CONDUCTOR_EVENT_TABLE=/m.test(fs.readFileSync(tmpEnv, "utf8")),
	(fs.readFileSync(tmpEnv, "utf8").match(/^# CONDUCTOR_EVENT_TABLE=.*/m) || ["(无注释行)"])[0]);
fs.appendFileSync(tmpEnv, "CONDUCTOR_EVENT_TABLE=real-events\n");
const againT = spawnSync("bash", [INSTALL], { env: over, encoding: "utf8" });
check("表名缝：文件里有值重装保全（当前环境未带不抹掉）",
	againT.status === 0 && fs.readFileSync(tmpEnv, "utf8").includes("CONDUCTOR_EVENT_TABLE=real-events") && againT.stdout.includes("保全既有表名行"),
	(againT.stdout.match(/保全既有表名行[^\n]*/) || ["(无保全行)"])[0]);
const withAmbient = spawnSync("bash", [INSTALL], { env: { ...over, CONDUCTOR_EVENT_TABLE: "ambient-table" }, encoding: "utf8" });
check("表名缝：当前 env 优先于文件既有值", withAmbient.status === 0 && fs.readFileSync(tmpEnv, "utf8").includes("CONDUCTOR_EVENT_TABLE=ambient-table"));

// ---- 5c. 通用缝保全（2026-09-30 wander，部署前体检发现）：任意 CONDUCTOR_* 缝行不因重装蒸发 ----
// 病例：fba4b11 落的 CONDUCTOR_SVPS_SSH 在只认预算/表名两行的重写里静默蒸发。
// 测试环境剥净 CONDUCTOR_* 噪声（conductor 会话里带着 env 文件的键，不剥则不密封）。
const tmpSeam = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-install-seam-"));
const seamEnvF = path.join(tmpSeam, "pianist", "conductor.env");
fs.mkdirSync(path.dirname(seamEnvF), { recursive: true });
fs.writeFileSync(seamEnvF, "# old\nZAI_CODING_CN_API_KEY=stale\nCONDUCTOR_SVPS_SSH=the-remote-test-host\nCONDUCTOR_SPOOR_FACE_COOLDOWN_H=6\n");
const seamOver = { ...CLEAN_ENV, ZAI_CODING_CN_API_KEY: "test-dummy-key-not-real", CONDUCTOR_ENV_FILE: seamEnvF, CONDUCTOR_UNIT_DEST: path.join(tmpSeam, "systemd"), CONDUCTOR_SYSTEMCTL: ":", CONDUCTOR_CGROUP_FILE: path.join(tmpSeam, "cg-none") };
const seamRun = spawnSync("bash", [INSTALL], { env: seamOver, encoding: "utf8" });
const seamText = seamRun.status === 0 ? fs.readFileSync(seamEnvF, "utf8") : "";
check("缝保全：SVPS_SSH 等既有 CONDUCTOR_* 行重装不蒸发且出声",
	seamRun.status === 0 && seamText.includes("CONDUCTOR_SVPS_SSH=the-remote-test-host") && seamText.includes("CONDUCTOR_SPOOR_FACE_COOLDOWN_H=6") && seamRun.stdout.includes("保全既有缝行"),
	(seamRun.stdout.match(/保全既有缝行[^\n]*/) || ["(无保全行)"])[0]);
const seamRun2 = spawnSync("bash", [INSTALL], { env: { ...seamOver, CONDUCTOR_SVPS_SSH: "ambient-host" }, encoding: "utf8" });
check("缝保全：当前 env 优先于文件既有值（同预算/表名纪律），其余缝行不动",
	seamRun2.status === 0 && fs.readFileSync(seamEnvF, "utf8").includes("CONDUCTOR_SVPS_SSH=ambient-host") && fs.readFileSync(seamEnvF, "utf8").includes("CONDUCTOR_SPOOR_FACE_COOLDOWN_H=6"),
	"");

// ---- 6. .gitignore 防呆：env 模式兜得住（万一有人把 conductor.env 拷进 repo） ----
const gi = spawnSync("git", ["check-ignore", "-q", "deploy/conductor.env"], { cwd: CWD, encoding: "utf8" });
check(".gitignore：deploy/conductor.env 被兜住（*.env 模式）", gi.status === 0, (gi.stderr || "").trim());
check(".gitignore：根下 conductor.env 也兜住", spawnSync("git", ["check-ignore", "-q", "conductor.env"], { cwd: CWD }).status === 0);check("真 env 目标在 repo 外（/etc/pianist/conductor.env 不可能进 git 工作树）",
	path.resolve("/etc/pianist/conductor.env") === "/etc/pianist/conductor.env" && !path.resolve("/etc/pianist/conductor.env").startsWith(CWD + path.sep));

// ---- 7. 壳 unit（seed③）：模板形状 + 展开落地 + 无 key ----
const shellUnit = fs.readFileSync(path.join(CWD, "deploy", "pianist-shell.service"), "utf8");
check("shell unit：端口内联 8770 + Restart=on-failure 有 RestartSec", /^Environment="PIANIST_SHELL_PORT=8770"$/m.test(shellUnit) && /^Restart=on-failure$/m.test(shellUnit) && /^RestartSec=/m.test(shellUnit));
check("shell unit：无任何 key 形状（壳无凭据，无需 EnvironmentFile——只看非注释行）",
	!/ZAI|API_KEY|TOKEN|SECRET|sk-|Bearer|EnvironmentFile/i.test(shellUnit.split(/\r?\n/).filter((l) => !l.trim().startsWith("#")).join("\n")));
check("shell unit：no_proxy 防劫（start-pianist.sh 同款——Clash 会劫 127.0.0.1）", /no_proxy=127\.0\.0\.1,localhost/.test(shellUnit));
const shellExpanded = shellUnit.replaceAll("__REPO_HOME__", path.resolve(CWD)).replaceAll("__NODE_BIN__", spawnSync("bash", ["-c", "command -v node"], { encoding: "utf8" }).stdout.trim());
const tmpShellVerify = path.join(os.tmpdir(), "pianist-shell-verify.service");
fs.writeFileSync(tmpShellVerify, shellExpanded);
const verShell = spawnSync("systemd-analyze", ["verify", tmpShellVerify], { encoding: "utf8" });
fs.rmSync(tmpShellVerify, { force: true });
check("shell unit：systemd-analyze verify 通过", verShell.status === 0, ((verShell.stdout || "") + (verShell.stderr || "")).trim().slice(0, 200));
check("真跑（旁路 tmp）：壳 unit 落地且为展开结果", envOk && fs.readFileSync(path.join(tmpUnitDir, "pianist-shell.service"), "utf8") === shellExpanded);

// ---- 8. 异名同源残骸拆除（seed②）：异名 unit ExecStart 指向本 repo → disable 出声 ----
const tmpAlien = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-install-alien-"));
const alienDir = path.join(tmpAlien, "systemd");
fs.mkdirSync(alienDir, { recursive: true });
fs.writeFileSync(path.join(alienDir, "portalk-conductor.service"), [
	"[Service]",
	`ExecStart=/usr/bin/node ${path.resolve(CWD)}/src/conductor.mjs`,
	"[Install]", "WantedBy=multi-user.target", "",
].join("\n"));
fs.writeFileSync(path.join(alienDir, "unrelated-app.service"), "[Service]\nExecStart=/usr/bin/sleep infinity\n"); // 无关 unit 不得误伤
const rec = path.join(tmpAlien, "systemctl.log");
const stub = path.join(tmpAlien, "systemctl-stub");
fs.writeFileSync(stub, `#!/usr/bin/env bash\necho "$*" >> "${rec}"\ncase "$1" in is-enabled|is-active|disable|stop|enable) exit 0;; show) exit 0;; esac\nexit 0\n`);
fs.chmodSync(stub, 0o755);
const alienEnv = { ...CLEAN_ENV, ZAI_CODING_CN_API_KEY: "test-dummy-key-not-real", CONDUCTOR_ENV_FILE: path.join(tmpAlien, "pianist", "conductor.env"), CONDUCTOR_UNIT_DEST: alienDir, CONDUCTOR_SYSTEMCTL: stub };
const alienRun = spawnSync("bash", [INSTALL], { env: alienEnv, encoding: "utf8" });
const recText = alienRun.status === 0 && fs.existsSync(rec) ? fs.readFileSync(rec, "utf8") : "";
check("残骸：异名同源 unit 被 disable（只 disable 不 stop——§3 钉子）", alienRun.status === 0 && alienRun.stdout.includes("残骸发现：portalk-conductor.service") && /disable portalk-conductor\.service/.test(recText) && !/stop portalk-conductor/.test(recText), (alienRun.stderr || "").trim().slice(0, 200));
check("残骸：无关 unit 不误伤（disable 列表里没有它）", alienRun.status === 0 && !recText.includes("unrelated-app"));
const alienAgain = spawnSync("bash", [INSTALL], { env: alienEnv, encoding: "utf8" });
check("残骸：二跑幂等（残骸已在，再拆一次不炸）", alienAgain.status === 0, (alienAgain.stderr || "").trim().slice(0, 200));

// ---- 9. shell 换防（seed③）：transient 在跑 → 先 stop 再拉正典，顺序可验 ----
const stubSwap = path.join(tmpAlien, "systemctl-swap");
fs.writeFileSync(stubSwap, `#!/usr/bin/env bash\necho "$*" >> "${rec}"\ncase "$1" in\n  is-active) exit 0;; # 伪：transient 壳在跑\n  show) echo "/run/systemd/transient/pianist-shell.service"; exit 0;; # 伪：FragmentPath 在 /run\n  *) exit 0;;\nesac\n`);
fs.chmodSync(stubSwap, 0o755);
fs.rmSync(rec, { force: true });
const swapRun = spawnSync("bash", [INSTALL], { env: { ...alienEnv, CONDUCTOR_SYSTEMCTL: stubSwap }, encoding: "utf8" });
const swapRec = swapRun.status === 0 && fs.existsSync(rec) ? fs.readFileSync(rec, "utf8") : "";
const stopIdx = swapRec.indexOf("stop pianist-shell");
const enableIdx = swapRec.indexOf("enable pianist-shell");
check("换防：识别 transient（FragmentPath 在 /run）→ stop 在 enable 之前，且换防理由出声", swapRun.status === 0 && swapRun.stdout.includes("换防") && stopIdx !== -1 && enableIdx !== -1 && stopIdx < enableIdx, (swapRun.stderr || "").trim().slice(0, 200));

// ---- 10. 预算行保全钉：重写 env 不抹 CONDUCTOR_DAILY_BUDGET ----
const tmpBud = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-install-budget-"));
const budEnv = path.join(tmpBud, "pianist", "conductor.env");
fs.mkdirSync(path.dirname(budEnv), { recursive: true });
fs.writeFileSync(budEnv, "# old\nZAI_CODING_CN_API_KEY=stale\nCONDUCTOR_DAILY_BUDGET=20\n");
const budEnvNoBudget = { ...CLEAN_ENV };
const budOver = { ...budEnvNoBudget, ZAI_CODING_CN_API_KEY: "test-dummy-key-not-real", CONDUCTOR_ENV_FILE: budEnv, CONDUCTOR_UNIT_DEST: path.join(tmpBud, "systemd"), CONDUCTOR_SYSTEMCTL: stub, CONDUCTOR_CGROUP_FILE: path.join(tmpAlien, "cg-none") };
const budRun = spawnSync("bash", [INSTALL], { env: budOver, encoding: "utf8" });
const budText = budRun.status === 0 ? fs.readFileSync(budEnv, "utf8") : "";
check("预算钉：当前 env 未带但文件有 → 拍板行保全（不因重装蒸发回默认 2）且出声说明",
	budRun.status === 0 && budText.includes("CONDUCTOR_DAILY_BUDGET=20") && budText.includes("test-dummy-key-not-real") && budRun.stdout.includes("保全"), (budRun.stderr || "").trim().slice(0, 200));
const budOver2 = { ...budOver, CONDUCTOR_DAILY_BUDGET: "5" };
const budRun2 = spawnSync("bash", [INSTALL], { env: budOver2, encoding: "utf8" });
check("预算钉：当前 env 带 → 新值写入（当前 env 优先于旧文件）",
	budRun2.status === 0 && fs.readFileSync(budEnv, "utf8").includes("CONDUCTOR_DAILY_BUDGET=5"), (budRun2.stderr || "").trim().slice(0, 200));

// ---- 10b. 柜分支（T15 活一）：柜有 coding-plan → env 文件不写 key 行，明文残留面收口 ----
{
	const tmpV = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-install-vault-"));
	const credDir = path.join(tmpV, "cred");
	fs.mkdirSync(credDir, { recursive: true });
	fs.writeFileSync(path.join(credDir, "coding-plan"), "vault-dummy-value-not-real", { mode: 0o600 });
	fs.chmodSync(path.join(credDir, "coding-plan"), 0o600);
	const vEnv = path.join(tmpV, "pianist", "conductor.env");
	fs.mkdirSync(path.dirname(vEnv), { recursive: true });
	fs.writeFileSync(vEnv, "# old\nZAI_CODING_CN_API_KEY=stale-old-key\nCONDUCTOR_SVPS_SSH=the-remote-test-host\n");
	const vOver = { ...CLEAN_ENV, PORTALK_CRED_DIR: credDir, ZAI_CODING_CN_API_KEY: "ambient-key-should-be-ignored", CONDUCTOR_ENV_FILE: vEnv, CONDUCTOR_UNIT_DEST: path.join(tmpV, "systemd"), CONDUCTOR_SYSTEMCTL: stub, CONDUCTOR_CGROUP_FILE: path.join(tmpV, "cg-none") };
	const vRun = spawnSync("bash", [INSTALL], { env: vOver, encoding: "utf8" });
	const vText = vRun.status === 0 ? fs.readFileSync(vEnv, "utf8") : "";
	check("柜分支：柜有 coding-plan → env 文件不写 key 行（ambient env 里的明文也不写——柜优先于 env）",
		vRun.status === 0 && !vText.includes("ZAI_CODING_CN_API_KEY=") && !vText.includes("ambient-key-should-be-ignored") && !vText.includes("vault-dummy-value-not-real"),
		vText.split("\n").filter((l) => l.includes("ZAI")).join("; ") || "(无 key 行)");
	check("柜分支：出声说明 key 走柜（听见即审计面）", vRun.status === 0 && vRun.stdout.includes("钥匙柜供 key"));
	check("柜分支：缝行保全不受柜分支影响（SVPS_SSH 还在）", vRun.status === 0 && vText.includes("CONDUCTOR_SVPS_SSH=the-remote-test-host"));
	fs.rmSync(tmpV, { recursive: true, force: true });
}

// ---- 11. 自保钉：活在 conductor cgroup 里 → 推迟重启出声，不自杀 ----
const cgConductor = path.join(tmpBud, "cg-conductor");
fs.writeFileSync(cgConductor, "0::/system.slice/pianist-conductor.service\n");
const cgOther = path.join(tmpBud, "cg-other");
fs.writeFileSync(cgOther, "0::/user.slice/user-0.slice/session-9.scope\n");
fs.rmSync(rec, { force: true });
const deferRun = spawnSync("bash", [INSTALL], { env: { ...budOver2, CONDUCTOR_CGROUP_FILE: cgConductor }, encoding: "utf8" });
const deferRec = deferRun.status === 0 && fs.existsSync(rec) ? fs.readFileSync(rec, "utf8") : "";
check("自保：安装者活在 conductor cgroup → 推迟出声且不 restart conductor（§1 钉子）",
	deferRun.status === 0 && deferRun.stdout.includes("推迟 conductor 重启") && !deferRec.includes("restart pianist-conductor") && deferRec.includes("restart pianist-shell"), (deferRun.stderr || "").trim().slice(0, 200));
fs.rmSync(rec, { force: true });
const normRun = spawnSync("bash", [INSTALL], { env: { ...budOver2, CONDUCTOR_CGROUP_FILE: cgOther }, encoding: "utf8" });
const normRec = normRun.status === 0 && fs.existsSync(rec) ? fs.readFileSync(rec, "utf8") : "";
check("自保：非 conductor cgroup（值班者/异机）→ 正常 restart conductor",
	normRun.status === 0 && normRec.includes("restart pianist-conductor"), (normRun.stderr || "").trim().slice(0, 200));
fs.rmSync(tmpBud, { recursive: true, force: true });
fs.rmSync(tmpAlien, { recursive: true, force: true });

// ---- 12. node 版本钉（engines>=22 同源）：部署 shell 解析到 node20 → 大声死 ----
const vbad = spawnSync("bash", [INSTALL, "--dry-run"], { env: { ...over, CONDUCTOR_NODE_BIN: "/bin/echo" }, encoding: "utf8" }); // echo --version → 无版本号
check("版本钉：NODE_BIN 出不来 v<数字> → 非零退出且明示正例（19连抽钉子的安装器半边）",
	vbad.status !== 0 && (vbad.stderr || "").includes("不达 >=22") && (vbad.stderr || "").includes("CONDUCTOR_NODE_BIN"), (vbad.stderr || "").trim().slice(0, 120));
const vgood = spawnSync("bash", [INSTALL, "--dry-run"], { env: { ...over, CONDUCTOR_NODE_BIN: process.execPath }, encoding: "utf8" });
check("版本钉：node>=22（跑测试的本 node）→ 过门 exit 0", vgood.status === 0, (vgood.stderr || "").trim().slice(0, 120));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
