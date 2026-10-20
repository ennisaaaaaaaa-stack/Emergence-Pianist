/**
 * review-chain-e2e-test.mjs —— 审链端到端（10/16 接线的「野外首燃」）：
 * 真实 buildRuntime + fake-pi（.mjs，秒退并吐 DONE）→ 施工分身退场 → completionPump →
 * 断言审链分身自动发车（模型/独立id/prompt 三件）→ 审链自身 DONE → 不递归。
 * 注：driver 无条件 process.execPath 起 entry（10/6 拍板②：爹用哪个 node 儿子用哪个），
 * 所以 fake pi 必须是 .mjs 不是 .sh。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntime } from "../src/orchestrator/runtime.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SHEET = `
任务：审链端到端

角色表：
  - 角色:worker pianist | 数量:1 | 沙箱:无 | 审链:评审员
  - 角色:评审员 | 数量:1 | 沙箱:无 | 模型:zai-coding-cn/glm-5.3-flash

预算袋：时长 10 分钟

交付物清单：
- out/final.png

验收标准：
- 出图非空

纪律：
- 不 commit
`;

test("端到端：DONE → 审链发车（模型覆盖+点名被审者）→ 审链 DONE 不递归", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "rc-e2e-"));
	const fakePi = path.join(dir, "fake-pi.mjs");
	writeFileSync(fakePi, `console.log("DONE fake-delivery");\n`);

	const rt = buildRuntime({
		sheetText: SHEET,
		piBin: fakePi,
		watchman: false,
		pollApprovals: false,
		supervisorCfg: { timeoutMs: 60_000 },
	});
	const spawnLog = [];
	const rs = rt.driver.spawn.bind(rt.driver);
	rt.driver.spawn = function (cfg) {
		spawnLog.push({ minionId: cfg.minionId, role: cfg.role, model: cfg.model ?? null, prompt: cfg.prompt ?? "" });
		return rs(cfg);
	};
	rt.launchMinion({ taskId: "e2e-1", role: "worker pianist" });
	// 施工分身（fake pi 秒退）→ completionPump → 审链发车（fake pi 再秒退，无审链声明→终点）
	await new Promise((r) => setTimeout(r, 1500));
	assert.equal(spawnLog.length, 2, `施工+审链各一发车（实际 ${spawnLog.length}：${spawnLog.map((s) => s.minionId).join(", ")}）`);
	assert.match(spawnLog[1].minionId, /-审-评审员$/, "审链 minionId 形状");
	assert.equal(spawnLog[1].model, "zai-coding-cn/glm-5.3-flash", "审链模型覆盖直达 spawn");
	assert.ok(spawnLog[1].prompt.includes("e2e-1-worker pianist-1"), "审链 prompt 点名被审者");
	await new Promise((r) => setTimeout(r, 500));
	assert.equal(spawnLog.length, 2, "审链自身 DONE 不递归");
});
