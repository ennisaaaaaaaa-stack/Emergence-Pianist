// §八第二铲测试：spoor-session part 真身——三件套机判 + prompt 牌面注入。
// 机判走行为测（conductor.mjs 顶层跑 main() 不能直接 import）：dry-run 演练面把真注入的
// prompt 整段出声（[spoor-prompt] 行），逐条机判与纪律从演练面断言——dry-run 即完整彩排。
// 三态同 todo-review：null=workbench 不可读（降级）/ []=真无债 / groups=牌面。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const CWD = path.resolve(import.meta.dirname, "..");
let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); }

function runOnce(root) {
	const r = spawnSync(process.execPath, [path.join(CWD, "src", "conductor.mjs"), "--once", "--dry-run"], {
		env: { ...process.env, CONDUCTOR_STIGMERGY_ROOT: root, CONDUCTOR_PARTS: "spoor-session", CONDUCTOR_STATE_DIR: path.join(root, "state"), CONDUCTOR_IDLE_NOW: "1" },
		encoding: "utf8",
	});
	return r.stdout + "\n" + r.stderr; // 降级 warn 在 stderr——并流才看得见
}

// ---- 场景A：真牌面——五种机判裁决各就各位 ----
// T12 够格（出处 collab#771 可指回 + 判据复测全对 + 预算 2026-09-30）
// T13 缺出处（「（口头）」不可指回）｜T14 缺判据（「优化性能」纯口号）｜T15 缺预算（无日期形状）
// T16 双缺（出处空+无预算）｜proj-b 旧格式行（不机判，格式非法待迁移）
const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), "spoor-session-test-"));
fs.mkdirSync(path.join(tmpA, "workbench", "proj-a"), { recursive: true });
fs.writeFileSync(path.join(tmpA, "workbench", "proj-a", "STATUS.md"), [
	"# STATUS",
	"## 做到哪",
	"打底",
	"## 下一步",
	"> 排序确认：2026-09-19（the user）·确认至第2条",
	"- T12 [collaborator-A] 修六轨器乐误判 ｜collab#771 协商9/19「装完music box先复测再修」｜判据：六轨复测全对｜预算：2026-09-30",
	"- T13 [the user] Orbi口径三题 ｜（口头）｜判据：口径表入库｜预算：3天内",
	"- T14 [collaborator-B] 走查遗留清理 ｜session 9/20 记录｜判据：优化性能｜预算：2026-10-01",
	"- T15 [collaborator-C] 文档补注 ｜collab#772｜判据：npm test 全绿（实跑验证）",
	"- T16 [the user] 隐债梳理 ｜｜判据：清单逐条核对",
	"## 卡在哪",
	"- 无",
].join("\n"));
fs.mkdirSync(path.join(tmpA, "workbench", "proj-b"), { recursive: true });
fs.writeFileSync(path.join(tmpA, "workbench", "proj-b", "STATUS.md"), "# STATUS\n## 下一步\n- ⑤第二铲：壳接线——/sandbox 路由+审批视线\n");
fs.mkdirSync(path.join(tmpA, "workbench", "proj-c"), { recursive: true }); // 无 STATUS.md 的目录不进牌面
const outA = runOnce(tmpA);
check("场景A：抽中 spoor-session 且计数行=够格1/跳过4（缺出处2·缺判据1·缺预算2）·格式非法1/2 项目",
	outA.includes("抽卡：spoor-session") && outA.includes("牌面 够格1/跳过4（缺出处2·缺判据1·缺预算2）·格式非法1/2 项目"),
	outA.split("\n").find((l) => l.includes("抽卡")));
check("场景A：够格例——T12 机判够格（出处可指回+判据可检查+预算有日期形状）", outA.includes("✔ T12 [collaborator-A] 修六轨器乐误判 —— 机判：够格"));
check("场景A：缺出处例——T13（（口头）不可指回）", outA.includes("T13 [the user] Orbi口径三题 —— 机判：跳过：缺出处"));
check("场景A：缺判据例——T14（优化性能=纯口号）", outA.includes("T14 [collaborator-B] 走查遗留清理 —— 机判：跳过：缺判据"));
check("场景A：缺预算例——T15（无日期形状）", outA.includes("T15 [collaborator-C] 文档补注 —— 机判：跳过：缺预算"));
check("场景A：多缺并列——T16 缺出处·缺预算", outA.includes("T16 [the user] 隐债梳理 —— 机判：跳过：缺出处·缺预算"));
check("场景A：格式非法例——proj-b 旧格式行不机判（待迁移）", outA.includes("[proj-b]") && outA.includes("⑤第二铲：壳接线——/sandbox 路由+审批视线 —— 机判：格式非法（旧格式，待迁移）"));
check("场景A：排序确认段头进牌面（spoor 用，todo-review 行文不进）", outA.includes("[proj-a]　排序确认：2026-09-19（the user）·确认至第2条"));
check("场景A：三题拍板进 prompt 纪律——认领算协商过+通知义务（/notify）",
	outA.includes("认领即算协商过") && outA.includes("/notify") && outA.includes("必须通知 the user"));
check("场景A：超预算报死拍板进 prompt——花钱 the user 拍/时间值班者拍",
	outA.includes("花钱的事 the user 拍板") && outA.includes("时间的事当天值班者拍板"));
check("场景A：收尾笔记契约+追认名单（拍板3）+只读不动账",
	outA.includes("够格 N 条/跳过 M 条") && outA.includes("供 the user 追认") && outA.includes("STATUS.md 不写回"));

// ---- 场景B：空「下一步」——真无债（counts 全 0 但不是降级） ----
const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "spoor-session-empty-"));
fs.mkdirSync(path.join(tmpB, "workbench", "proj-x"), { recursive: true });
fs.writeFileSync(path.join(tmpB, "workbench", "proj-x", "STATUS.md"), "# STATUS\n## 下一步\n\n## 卡在哪\n- 无\n");
const outB = runOnce(tmpB);
check("场景B：空段=真无债（够格0/跳过0/格式非法0，项目计数仍在）+ prompt 明说均空",
	outB.includes("牌面 够格0/跳过0（缺出处0·缺判据0·缺预算0）·格式非法0/1 项目") && outB.includes("各项目「下一步」段均空"),
	outB.split("\n").find((l) => l.includes("抽卡")));

// ---- 场景C：workbench 根不存在——降级 null 出声（拉不到≠没有） ----
const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), "spoor-session-degraded-"));
const outC = runOnce(path.join(tmpC, "no-such-root"));
check("场景C：不可读=降级出声（spoor-session 名头的 warn + 抽卡行 + prompt 降级文案）",
	outC.includes("spoor-session 牌面预取失败") && outC.includes("牌面 预取失败降级") && outC.includes("拉不到牌面不等于没有债"),
	outC.split("\n").filter((l) => l.includes("抽卡") || l.includes("预取失败"))[0]);

console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
