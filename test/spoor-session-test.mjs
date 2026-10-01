// §八第二铲测试：spoor-session part 真身——三件套机判 + prompt 牌面注入。
// 机判走行为测（conductor.mjs 顶层跑 main() 不能直接 import）：dry-run 演练面把真注入的
// prompt 整段出声（[spoor-prompt] 行），逐条机判与纪律从演练面断言——dry-run 即完整彩排。
// 三态同 todo-review：null=workbench 不可读（降级）/ []=真无债 / groups=牌面。
// T8 牌面格式机械迁移位（2026-10-02）：读入侧虚拟迁移——旧格式行进管线自动转 v0.9 形状，
// STATUS.md 原文不写。场景A 翻新（⑤第二铲行迁移发号 T101 进机判）、场景D ID 变体三样本
// （剥装饰/撞号加撇/大号段 max+1 发号）、场景E 散文行不转单列、场景F todo-review 行文牌面
// 路的迁移标注。收敛行「格式非法」字样清零，counts 拆 migrated/prose。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const CWD = path.resolve(import.meta.dirname, "..");
let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`); }

function runOnce(root, part = "spoor-session") {
	const r = spawnSync(process.execPath, [path.join(CWD, "src", "conductor.mjs"), "--once", "--dry-run"], {
		// 预算闸隔离：dailySpendYen 默认读仓内真实 data/telemetry——真机当天烧≥2 元会硬停拦住抽卡，
		// 测试被真实账本劫持。指到 tmp 空账本（与 queue-e2e/todo-review 的隔离姿势同款）。
		env: { ...process.env, CONDUCTOR_STIGMERGY_ROOT: root, CONDUCTOR_PARTS: part, CONDUCTOR_STATE_DIR: path.join(root, "state"), CONDUCTOR_IDLE_NOW: "1", PIANIST_TELEMETRY_DIR: path.join(root, "tel") },
		encoding: "utf8",
	});
	return r.stdout + "\n" + r.stderr; // 降级 warn 在 stderr——并流才看得见
}

// ---- 场景A：真牌面——五种机判裁决各就各位 + proj-b 旧格式行迁移发号 ----
// T12 够格（出处 collab#771 可指回 + 判据复测全对 + 预算 2026-09-30）
// T13 缺出处（「（口头）」不可指回）｜T14 缺判据（「优化性能」纯口号）｜T15 缺预算（无日期形状）
// T16 双缺（出处空+无预算）｜proj-b 旧格式行（9/26 前旧牌面真身：裸 bullet 无 ID → 机械发号
// T101——proj-b 段内无 T 号，100 内是活人手写号段管线避开——缺栏空着照判，旧格式零丢弃）
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
check("场景A：抽中 spoor-session 且计数行=够格1/跳过5（缺出处3·缺判据2·缺预算3）·迁移1·散文0/2 项目（malformed 口径已拆）",
	outA.includes("抽卡：spoor-session") && outA.includes("牌面 够格1/跳过5（缺出处3·缺判据2·缺预算3）·迁移1·散文0/2 项目"),
	outA.split("\n").find((l) => l.includes("抽卡")));
check("场景A：迁移出声——proj-b 1 条旧格式→v0.9 形状（T101），虚拟迁移明说不写原文",
	outA.includes("[conductor] 牌面迁移：proj-b 1 条旧格式→v0.9 形状（T101）") && outA.includes("STATUS.md 原文不写"),
	outA.split("\n").find((l) => l.includes("牌面迁移")));
check("场景A：够格例——T12 机判够格（出处可指回+判据可检查+预算有日期形状）", outA.includes("✔ T12 [collaborator-A] 修六轨器乐误判 —— 机判：够格"));
check("场景A：缺出处例——T13（（口头）不可指回）", outA.includes("T13 [the user] Orbi口径三题 —— 机判：跳过：缺出处"));
check("场景A：缺判据例——T14（优化性能=纯口号）", outA.includes("T14 [collaborator-B] 走查遗留清理 —— 机判：跳过：缺判据"));
check("场景A：缺预算例——T15（无日期形状）", outA.includes("T15 [collaborator-C] 文档补注 —— 机判：跳过：缺预算"));
check("场景A：多缺并列——T16 缺出处·缺预算", outA.includes("T16 [the user] 隐债梳理 —— 机判：跳过：缺出处·缺预算"));
check("场景A：旧账翻新——⑤第二铲行迁移发号 T101 进机判，缺栏空着如实报（管形状不造内容）",
	outA.includes("T101 [] ⑤第二铲：壳接线——/sandbox 路由+审批视线（迁移 T101） —— 机判：跳过：缺出处·缺判据·缺预算"),
	outA.split("\n").find((l) => l.includes("T101")));
check("场景A：零「格式非法」标记——旧格式行不再落 malformed 桶", !outA.includes("格式非法"));
check("场景A：排序确认段头进牌面（spoor 用，todo-review 行文不进）", outA.includes("[proj-a]　排序确认：2026-09-19（the user）·确认至第2条"));
check("场景A：三题拍板进 prompt 纪律——认领算协商过+通知义务（/notify）",
	outA.includes("认领即算协商过") && outA.includes("/notify") && outA.includes("必须通知 the user"));
check("场景A：超预算报死拍板进 prompt——花钱 the user 拍/时间值班者拍",
	outA.includes("花钱的事 the user 拍板") && outA.includes("时间的事当天值班者拍板"));
check("场景A：收尾笔记新口径（迁移 J 条/散文 D 条）+追认名单（拍板3）+只读不动账",
	outA.includes("够格 N 条/跳过 M 条") && outA.includes("迁移 J 条/散文 D 条") && outA.includes("供 the user 追认") && outA.includes("STATUS.md 不写回"));
check("场景A：牌面标注语义进 prompt——虚拟迁移+撞号加撇+散文不转",
	outA.includes("读入侧虚拟迁移") && outA.includes("加撇保唯一") && outA.includes("散文不是条目"));

// ---- 场景B：空「下一步」——真无债（counts 全 0 但不是降级） ----
const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), "spoor-session-empty-"));
fs.mkdirSync(path.join(tmpB, "workbench", "proj-x"), { recursive: true });
fs.writeFileSync(path.join(tmpB, "workbench", "proj-x", "STATUS.md"), "# STATUS\n## 下一步\n\n## 卡在哪\n- 无\n");
const outB = runOnce(tmpB);
check("场景B：空段=真无债（够格0/跳过0/迁移0/散文0，项目计数仍在）+ prompt 明说均空",
	outB.includes("牌面 够格0/跳过0（缺出处0·缺判据0·缺预算0）·迁移0·散文0/1 项目") && outB.includes("各项目「下一步」段均空"),
	outB.split("\n").find((l) => l.includes("抽卡")));

// ---- 场景C：workbench 根不存在——降级 null 出声（拉不到≠没有） ----
const tmpC = fs.mkdtempSync(path.join(os.tmpdir(), "spoor-session-degraded-"));
const outC = runOnce(path.join(tmpC, "no-such-root"));
check("场景C：不可读=降级出声（spoor-session 名头的 warn + 抽卡行 + prompt 降级文案）",
	outC.includes("spoor-session 牌面预取失败") && outC.includes("牌面 预取失败降级") && outC.includes("拉不到牌面不等于没有债"),
	outC.split("\n").filter((l) => l.includes("抽卡") || l.includes("预取失败"))[0]);

// ---- 场景D：ID 变体三样本（T8 真身）——剥装饰裸号进机判、撞号加撇不重号、大号段 max+1 发号 ----
// proj-d（10/01 实录形状）：T6 既有 + T6(新) 撞号 → 剥装饰取裸号撞 T6 → 加撇 T6'；
// T3(改) 无撞 → 剥装饰裸号 T3 直接进机判。
// proj-e（9/26 前旧牌面形状）：段内既有 T105（>100 大号段）+ 两条裸 bullet → max+1 发号 T106/T107。
const tmpD = fs.mkdtempSync(path.join(os.tmpdir(), "spoor-session-migrate-"));
fs.mkdirSync(path.join(tmpD, "workbench", "proj-d"), { recursive: true });
fs.writeFileSync(path.join(tmpD, "workbench", "proj-d", "STATUS.md"), [
	"# STATUS",
	"## 下一步",
	"- T6 [the author] 六轨复测补跑 ｜collab#771｜判据：npm test 全绿（实跑验证）｜预算：2026-10-01",
	"- T6(新) [the author] 误判样本归档 ｜collab#772｜判据：入库核对｜预算：2026-10-02",
	"- T3(改) [the author] 口径对齐 ｜collab#773｜判据：口径表入库复测｜预算：2026-10-03",
	"## 卡在哪",
	"- 无",
].join("\n"));
fs.mkdirSync(path.join(tmpD, "workbench", "proj-e"), { recursive: true });
fs.writeFileSync(path.join(tmpD, "workbench", "proj-e", "STATUS.md"), [
	"# STATUS",
	"## 下一步",
	"- T105 [the author] 既有大号条目｜collab#780｜判据：npm test 全绿｜预算：2026-10-07",
	"- ⑥第三铲：探针挂账——收尾笔记对齐",
	"- 零散尾注补档",
].join("\n"));
const outD = runOnce(tmpD);
check("场景D：计数行=够格4/跳过2·迁移4·散文0/2 项目",
	outD.includes("牌面 够格4/跳过2（缺出处2·缺判据2·缺预算2）·迁移4·散文0/2 项目"),
	outD.split("\n").find((l) => l.includes("抽卡")));
check("场景D：剥装饰裸号进机判——T3(改)→T3 够格，零格式非法",
	outD.includes("✔ T3 [the author] 口径对齐（迁移 T3） —— 机判：够格") && !outD.includes("格式非法"),
	outD.split("\n").find((l) => l.includes("T3 [the author]")));
check("场景D：撞号加撇——T6(新) 段内已有 T6 → T6' 且标迁移改名，照样够格",
	outD.includes("✔ T6' [the author] 误判样本归档（迁移 T6'·迁移改名） —— 机判：够格"),
	outD.split("\n").find((l) => l.includes("T6'")));
check("场景D：不重号——原 T6 照判无改名、T6' 全场恰一次（机械迁移绝不造重号）",
	outD.includes("✔ T6 [the author] 六轨复测补跑 —— 机判：够格") && (outD.match(/T6' \[the author\]/g) ?? []).length === 1);
check("场景D：大号段发号走 max+1——T105 段内裸 bullet → T106/T107（不是 T101）",
	outD.includes("牌面迁移：proj-e 2 条旧格式→v0.9 形状（T106·T107）") && outD.includes("T106 [] ⑥第三铲：探针挂账——收尾笔记对齐（迁移 T106） —— 机判：跳过：缺出处·缺判据·缺预算"),
	outD.split("\n").find((l) => l.includes("牌面迁移：proj-e")));
check("场景D：迁移出声（proj-d 两条，撞号改名者带撇入列）", outD.includes("牌面迁移：proj-d 2 条旧格式→v0.9 形状（T6'·T3）"));

// ---- 场景E：内联散文体（tideline 9/24 真身）——不转不判单列，不进 malformed 也不进迁移 ----
// 原文已随 09-25 v0.9 重写不在盘上，此处照抄任务书引文为 record：散文不是条目，转了是伪造结构。
const tmpE = fs.mkdtempSync(path.join(os.tmpdir(), "spoor-session-prose-"));
fs.mkdirSync(path.join(tmpE, "workbench", "proj-f"), { recursive: true });
fs.writeFileSync(path.join(tmpE, "workbench", "proj-f", "STATUS.md"), [
	"# STATUS · 更新于 2026-09-24 22:36",
	"## 下一步",
	"下一步：§九唤起细则+…均已落 → 差预算数字…",
].join("\n"));
const outE = runOnce(tmpE);
check("场景E：散文行单列非条目（散文段）不机判，不进 malformed",
	outE.includes("下一步：§九唤起细则+…均已落 → 差预算数字… —— 机判：非条目（散文段）·不机判") && !outE.includes("格式非法"),
	outE.split("\n").find((l) => l.includes("散文段")));
check("场景E：计数行散文口径——迁移0·散文1，散文不进迁移计数",
	outE.includes("牌面 够格0/跳过0（缺出处0·缺判据0·缺预算0）·迁移0·散文1/1 项目") && !outE.includes("牌面迁移："),
	outE.split("\n").find((l) => l.includes("抽卡")));

// ---- 场景F：todo-review 行文牌面路的迁移可见性——迁移标注两条牌面路都带 ----
// （spoor 走 boards，todo-review 走 lines；同一迁移在两条路上都要让看牌面的活人认出「管线转的」）
const tmpF = fs.mkdtempSync(path.join(os.tmpdir(), "todo-review-migrate-"));
fs.mkdirSync(path.join(tmpF, "workbench", "proj-g"), { recursive: true });
fs.writeFileSync(path.join(tmpF, "workbench", "proj-g", "STATUS.md"), "# STATUS\n## 下一步\n- ⑤第二铲：壳接线——/sandbox 路由+审批视线\n");
const outF = runOnce(tmpF, "todo-review");
check("场景F：行文牌面带（迁移 T101）标注+迁移出声",
	outF.includes("- [proj-g] T101 [] ⑤第二铲：壳接线——/sandbox 路由+审批视线（迁移 T101）") && outF.includes("牌面迁移：proj-g 1 条旧格式→v0.9 形状（T101）"),
	outF.split("\n").find((l) => l.includes("proj-g")));
check("场景F：todo-review prompt 语义同步——虚拟迁移不写回+待迁移留给活人+散文不转",
	outF.includes("虚拟迁移只转管线内存里的牌面") && outF.includes("仍待迁移") && outF.includes("（非条目·散文段）") && outF.includes("迁移几条、散文几条"));

console.log(`\n${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
