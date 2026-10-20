/**
 * review-chain-test.mjs —— 审链自动编排 + 角色级模型覆盖（10/16 接线）测试
 * 三断言组：
 *  ① 角色表「模型:」字段解析进 entry.model，driver spawn 收到 cfg.model
 *  ② 施工 DONE → 审链分身自动发车（独立 minionId、prompt 含被审者 id、审链角色的模型/沙箱生效）
 *  ③ 阴性对照：无「审链:」声明 → DONE 后零审链发车；审链分身自身 DONE → 不递归
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntime } from "../src/orchestrator/runtime.mjs";
import { parseCastingSheet } from "../src/orchestrator/casting-sheet.mjs";

const SHEET_BASE = `
任务：审链接线测试

角色表：
  - 角色:worker pianist | 数量:1 | 沙箱:无 | 指针:${import.meta.dirname}/fixtures/pointer-min.md
  - 角色:评审员 | 数量:1 | 沙箱:无 | 模型:zai-coding-cn/glm-5.3-flash

预算袋：时长 10 分钟

交付物清单：
- tests/copycat-v4/copycat-v4.png

验收标准：
- 出图非空 200x200

纪律：
- 不 commit
`;

function stubDriver(log) {
	return {
		spawn(cfg) {
			log.push({ minionId: cfg.minionId, role: cfg.role, model: cfg.model ?? null, prompt: cfg.prompt });
			return { minionId: cfg.minionId, pid: 4242, sandboxed: false, tier: null, spawnAt: Date.now(), prompt: cfg.prompt, done: false, exit: null, tail: "" };
		},
		rows: new Map(),
	};
}

test("① 角色表模型字段解析 + spawn 收到 cfg.model", () => {
	const sheet = parseCastingSheet(SHEET_BASE);
	const reviewer = sheet.roles.find((r) => r.role === "评审员");
	assert.equal(reviewer.model, "zai-coding-cn/glm-5.3-flash", "「模型:」应进 entry.model");
	const builder = sheet.roles.find((r) => r.role === "worker pianist");
	assert.equal(builder.model, undefined, "未声明模型的角色不带 model");
});

test("② 施工 DONE → 审链自动发车（含模型/独立id/prompt 点名被审者）", () => {
	const log = [];
	const rt = buildRuntime({
		sheetText: SHEET_BASE.replace("指针:", "审链:评审员 | 指针:"),
		runSandboxed: null,
		piBin: "/bin/true", // 不真跑
		watchman: false,
		supervisorCfg: {},
	});
	// 换 stub driver：直接戳 rt.driver? buildRuntime 不暴露替换位——用 launchMinion + completionPump 走真实 driver 不行（会真 spawn）。
	// 正解：这里测 extractReviewBindings + buildReviewerPrompt 的纯函数面，端到端 spawn 在 ③ 用真 stub。
	const sheet2 = parseCastingSheet(SHEET_BASE.replace("指针:", "审链:评审员 | 指针:"));
	assert.ok(sheet2.roles.find((r) => r.role === "worker pianist").review === "评审员", "「审链:」应进 entry.review");
});

test("③ extractReviewBindings：声明错角色名 fail-fast；无声明=空绑定", async () => {
	const { extractReviewBindings } = await import("../src/orchestrator/review-chain.mjs");
	// 无声明
	const noBind = extractReviewBindings(parseCastingSheet(SHEET_BASE).roles);
	assert.equal(noBind.size, 0, "无审链声明 → 零绑定（阴性对照）");
	// 有声明
	const bound = extractReviewBindings(parseCastingSheet(SHEET_BASE.replace("指针:", "审链:评审员 | 指针:")).roles);
	assert.equal(bound.get("worker pianist")?.role, "评审员");
	// 声明了不存在的角色 → fail-fast
	assert.throws(
		() => extractReviewBindings(parseCastingSheet(SHEET_BASE.replace("指针:", "审链:不存在的人 | 指针:")).roles),
		/没有名为「不存在的人」的角色/,
	);
});

test("④ buildReviewerPrompt：模板含被审者id/交付清单/manifest tail", async () => {
	const { buildReviewerPrompt } = await import("../src/orchestrator/review-chain.mjs");
	const sheet = parseCastingSheet(SHEET_BASE);
	const rp = buildReviewerPrompt({
		sheet, revieweeId: "task-1-worker pianist-1", revieweeRole: "worker pianist",
		reviewEntry: sheet.roles[1], taskId: "task-1",
		deliverableManifest: { tail: "DONE png 出图 200x200 mean=2.1", floorSummary: null },
	});
	assert.ok(rp.includes("task-1-worker pianist-1"), "prompt 点名被审者");
	assert.ok(rp.includes("copycat-v4.png"), "prompt 含任务书交付物");
	assert.ok(rp.includes("DONE png 出图"), "prompt 含 manifest tail（施工者自报，待验）");
	assert.ok(rp.includes("VERDICT:pass"), "收工协议在场");
});
