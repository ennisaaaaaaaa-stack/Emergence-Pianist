/**
 * review-chain-verdict-test.mjs —— VERDICT 协议分支（10/16 补丁）：审链分身吐 VERDICT:pass/fail
 * → completionPump 认这个形状（不再误报 session death），交货单带 verdict 字段落收件箱。
 * fake-pi 按参数变行为：被审者吐 DONE，审链分身吐 VERDICT:fail。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildRuntime } from "../src/orchestrator/runtime.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const SHEET = `
任务：审链VERDICT协议

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

test("审链分身 VERDICT:fail → 交货单带 verdict，不再 session death", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "rc-verdict-"));
	const fakePi = path.join(dir, "fake-pi.mjs");
	// 按最后一个位置参数（prompt）里的身份变行为：审链 prompt 含「审链任务」字样
	writeFileSync(fakePi, `
const prompt = process.argv[process.argv.length - 1] ?? "";
if (prompt.includes("审链任务")) {
	console.log("红项1：出图为空。红项2：mean 无读数。");
	console.log("VERDICT:fail");
} else {
	console.log("DONE fake-delivery");
}
`);

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
	rt.launchMinion({ taskId: "v-1", role: "worker pianist" });
	await new Promise((r) => setTimeout(r, 2000));

	assert.equal(spawnLog.length, 2, `施工+审链各一（实际 ${spawnLog.length}）`);
	// 收件箱里的交付形状：第二封交货单必须带 verdict=fail（不是讣告）
	const deliveries = rt.inbox.peekAll().filter((m) => m.kind === "交货单");
	assert.equal(deliveries.length, 2, `两封交货单（实际 ${deliveries.length}，inbox: ${JSON.stringify(rt.inbox.peekAll().map((m) => m.kind))}）`);
	const reviewDelivery = deliveries.find((d) => d.minionId?.includes("-审-"));
	assert.ok(reviewDelivery, "审链分身的交货单在场");
	assert.equal(reviewDelivery.manifest?.verdict, "fail", "verdict 字段=fail");
	assert.ok(String(reviewDelivery.manifest?.tail).includes("红项1"), "tail 带红项全文");
	// 没有讣告（session death 误报的形状）
	const obituaries = rt.inbox.peekAll().filter((m) => m.kind === "讣告");
	assert.equal(obituaries.length, 0, `零讣告（实际 ${obituaries.length}——VERDICT 被误判 session death 的话这里会冒讣告）`);
});
