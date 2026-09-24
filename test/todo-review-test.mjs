// §八第一铲测试：todo-review 牌面管线——fetchTodoBoard 形状 + prompt 注入三态
// 三态：null=workbench 不可读（降级）/ []=真无债 / lines=牌面
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

const CWD = path.resolve(import.meta.dirname, "..");
let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); }

// conductor.mjs 顶层会跑 main()，不能直接 import——用独立 tmp 进程按函数体提取不划算，
// 改走行为测：CONDUCTOR_STIGMERGY_ROOT 指到 tmp workbench，--once --dry-run 抽卡打到 todo-review
// 的路径需要强制 CONDUCTOR_PARTS=todo-review。

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "todo-review-test-"));

// ---- 场景A：真牌面——两个项目，一新一旧格式混合 ----
fs.mkdirSync(path.join(tmp, "workbench", "proj-a", "STATUS.md", ".."), { recursive: true });
fs.writeFileSync(path.join(tmp, "workbench", "proj-a", "STATUS.md"), [
	"# STATUS",
	"## 做到哪",
	"打底",
	"## 下一步",
	"> 排序确认：2026-09-19（甜心）·确认至第1条",
	"- T12 [洄] 修六轨器乐误判 ｜协商9/19「装完music box先复测再修」｜判据：六轨复测全对",
	"- T13 [甜心] Orbi口径三题 ｜派单9/18「材料提前一周拿到」｜判据：口径表入库",
	"## 卡在哪",
	"- 无",
].join("\n"));
fs.mkdirSync(path.join(tmp, "workbench", "proj-b"), { recursive: true });
fs.writeFileSync(path.join(tmp, "workbench", "proj-b", "STATUS.md"), [
	"# STATUS",
	"## 下一步",
	"- ⑤第二铲：壳接线——/sandbox 路由进 shell.mjs（非条目格式）",
].join("\n"));
fs.mkdirSync(path.join(tmp, "workbench", "proj-c"), { recursive: true }); // 无 STATUS.md 的目录不进牌面
fs.writeFileSync(path.join(tmp, "workbench", "unrelated.txt"), "junk");

const envA = { ...process.env, CONDUCTOR_STIGMERGY_ROOT: tmp, CONDUCTOR_PARTS: "todo-review", CONDUCTOR_STATE_DIR: path.join(tmp, "state"), CONDUCTOR_IDLE_NOW: "1" };
const outA = execFileSync("NODE_BIN", [path.join(CWD, "src", "conductor.mjs"), "--once", "--dry-run"], { env: envA, encoding: "utf8" });
check("场景A：抽到 todo-review 且牌面行数=3（2条目+1旧格式）", outA.includes("todo-review") && outA.includes("牌面 3 行/2 项目"), outA.trim().split("\n").pop());

// dry-run 不落 state——prompt 细节用子进程再验：直接跑一次非 dry 拉起太贵，改验 prompt 生成函数可从 stdout 断言的部分已够；
// prompt 注入三态的字符串面用 node -e 复刻 fetchTodoBoard 逻辑太脆——改为读源码断言降级文案在 prompt 模板里（结构面）。
const src = fs.readFileSync(path.join(CWD, "src", "conductor.mjs"), "utf8");
check("场景A2：prompt 模板含三件套判据与跳过语义（拉不到≠没有）", src.includes("拉不到清单不等于清单为空") && src.includes("跳过：缺X") && src.includes("待迁移"), "");

// ---- 场景B：空「下一步」——牌面 lines=0/项目计数仍在 ----
const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "todo-review-empty-"));
fs.mkdirSync(path.join(tmpB, "workbench", "proj-x"), { recursive: true });
fs.writeFileSync(path.join(tmpB, "workbench", "proj-x", "STATUS.md"), "# STATUS\n## 下一步\n\n## 卡在哪\n- 无\n");
const envB = { ...process.env, CONDUCTOR_STIGMERGY_ROOT: tmpB, CONDUCTOR_PARTS: "todo-review", CONDUCTOR_STATE_DIR: path.join(tmpB, "state"), CONDUCTOR_IDLE_NOW: "1" };
const outB = execFileSync("NODE_BIN", [path.join(CWD, "src", "conductor.mjs"), "--once", "--dry-run"], { env: envB, encoding: "utf8" });
check("场景B：空段=真无债（0 行但不是降级）", outB.includes("牌面 0 行/1 项目"), outB.trim().split("\n").pop());

// ---- 场景C：workbench 根不存在——降级 null 出声 ----
const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), "todo-review-degraded-"));
const envC = { ...process.env, CONDUCTOR_STIGMERGY_ROOT: path.join(tmpC, "no-such-root"), CONDUCTOR_PARTS: "todo-review", CONDUCTOR_STATE_DIR: path.join(tmpC, "state"), CONDUCTOR_IDLE_NOW: "1" };
const runC = spawnSync("NODE_BIN", [path.join(CWD, "src", "conductor.mjs"), "--once", "--dry-run"], { env: envC, encoding: "utf8" });
const outC = runC.stdout + "\n" + runC.stderr; // 降级 warn 在 stderr——必须并流才看得见
check("场景C：不可读=降级出声（拉不到≠没有）", outC.includes("todo-review 牌面预取失败") && outC.includes("预取失败降级"), outC.trim().split("\n").filter((l) => l.includes("抽卡"))[0]);

// ---- 场景D：node 版本自白进启动日志（19连抽钉子，洄#771）----
const outD = execFileSync("NODE_BIN", [path.join(CWD, "src", "conductor.mjs"), "--status"], { env: envA, encoding: "utf8" });
check("场景D：启动日志含 node 版本自白（--status 路径不走常驻行，结构面断言源码）", src.includes("19连抽事故的钉子") && src.includes("node=${process.execPath}"), "");

console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
