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
let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); }

const unit = fs.readFileSync(UNIT, "utf8");

// ---- 1. unit 关键字段：重启姿势 / 依赖序 / env 在 repo 外 / 无 key ----
check("unit：After=network.target（照 tideline 先例）", /^After=network\.target$/m.test(unit));
check("unit：Restart=on-failure + RestartSec 有值", /^Restart=on-failure$/m.test(unit) && /^RestartSec=\d+$/m.test(unit));
check("unit：EnvironmentFile 指向 /etc/pianist/conductor.env（repo 外）", /^EnvironmentFile=\/etc\/pianist\/conductor\.env$/m.test(unit));
check("unit：不含任何 key 名/值（连名字都不该出现，注入只走 EnvironmentFile）", !/ZAI|API_KEY|TOKEN|SECRET|sk-|Bearer/i.test(unit));

// ---- 2. systemd-analyze verify（只读语法校验；env 文件此时可以不存在——verify 不查其存在性） ----
const ver = spawnSync("systemd-analyze", ["verify", UNIT], { encoding: "utf8" });
check("systemd-analyze verify 通过（exit=0）", ver.status === 0, ((ver.stdout || "") + (ver.stderr || "")).trim().slice(0, 200));

// ---- 3. install 脚本：bash -n 语法 + 缺 key 大声死（不装哑巴） ----
check("install：bash -n 语法通过", spawnSync("bash", ["-n", INSTALL]).status === 0);
const noKeyEnv = { ...process.env };
delete noKeyEnv.ZAI_CODING_CN_API_KEY;
const noKey = spawnSync("bash", [INSTALL, "--dry-run"], { env: noKeyEnv, encoding: "utf8" });
check("install：缺 ZAI_CODING_CN_API_KEY → 非零退出 + stderr 出声", noKey.status !== 0 && (noKey.stderr || "").includes("不静默") && (noKey.stderr || "").includes("ZAI_CODING_CN_API_KEY"));

// ---- 4. dry-run：只打印不动系统（旁路目标指 tmp，断言 tmp 无副作用即证明没写） ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "conductor-install-test-"));
const tmpEnv = path.join(tmp, "pianist", "conductor.env");
const tmpUnitDir = path.join(tmp, "systemd");
const over = { ...process.env, ZAI_CODING_CN_API_KEY: "test-dummy-key-not-real", CONDUCTOR_ENV_FILE: tmpEnv, CONDUCTOR_UNIT_DEST: tmpUnitDir, CONDUCTOR_SYSTEMCTL: ":" };
const dry = spawnSync("bash", [INSTALL, "--dry-run"], { env: over, encoding: "utf8" });
check("dry-run：exit=0 且打印计划（含 [dry-run] 标记与 600 权限声明）", dry.status === 0 && dry.stdout.includes("[dry-run]") && dry.stdout.includes("chmod 600"));
check("dry-run：不动系统——env/unit 目标均未创建", !fs.existsSync(tmpEnv) && !fs.existsSync(tmpUnitDir));

// ---- 5. tmp 沙盒真跑（SYSTEMCTL=: 吞掉 systemctl 步骤）：文件落地 + 权限 + key 不进 unit ----
const real = spawnSync("bash", [INSTALL], { env: over, encoding: "utf8" });
const envOk = real.status === 0 && fs.existsSync(tmpEnv) && fs.existsSync(path.join(tmpUnitDir, "pianist-conductor.service"));
check("真跑（旁路 tmp）：exit=0，env+unit 落地", envOk, (real.stderr || "").trim().slice(0, 200));
check("真跑（旁路 tmp）：env 文件含 key 且权限 600（创建即 600，无中间态）",
	envOk && fs.readFileSync(tmpEnv, "utf8").includes("ZAI_CODING_CN_API_KEY=test-dummy-key-not-real") && (fs.statSync(tmpEnv).mode & 0o777) === 0o600,
	`mode=${(fs.statSync(tmpEnv).mode & 0o777).toString(8)}`);
check("真跑（旁路 tmp）：落地的 unit 与 repo 源一致（key 不可能混进去）",
	envOk && fs.readFileSync(path.join(tmpUnitDir, "pianist-conductor.service"), "utf8") === unit);
const again = spawnSync("bash", [INSTALL], { env: over, encoding: "utf8" });
check("幂等：同参数二跑 exit=0 不炸", again.status === 0, (again.stderr || "").trim().slice(0, 200));

// ---- 6. .gitignore 防呆：env 模式兜得住（万一有人把 conductor.env 拷进 repo） ----
const gi = spawnSync("git", ["check-ignore", "-q", "deploy/conductor.env"], { cwd: CWD, encoding: "utf8" });
check(".gitignore：deploy/conductor.env 被兜住（*.env 模式）", gi.status === 0, (gi.stderr || "").trim());
check(".gitignore：根下 conductor.env 也兜住", spawnSync("git", ["check-ignore", "-q", "conductor.env"], { cwd: CWD }).status === 0);check("真 env 目标在 repo 外（/etc/pianist/conductor.env 不可能进 git 工作树）",
	path.resolve("/etc/pianist/conductor.env") === "/etc/pianist/conductor.env" && !path.resolve("/etc/pianist/conductor.env").startsWith(CWD + path.sep));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
