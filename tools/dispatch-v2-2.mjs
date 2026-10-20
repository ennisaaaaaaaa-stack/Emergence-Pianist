#!/usr/bin/env node
// v2-2 发车脚本：用 ⑧-2 编排器真身发车pianist（施工分身）跑 v2-2 两铲
// 用法：node tools/dispatch-v2-2.mjs [--dry-run]
// 这是编排器真身首战——发车脚本本身就是心跳源①修复的野外验收（pianist会话落子目录，watcher 递归扫必须锁上）

import { buildRuntime } from "../src/orchestrator/index.mjs";
import fs from "node:fs";

const DRY = process.argv.includes("--dry-run");
const CWD = "/root/portalk-runtime";
const sheetText = fs.readFileSync(`${CWD}/data/casting-sheets/2026-10-10-v2-2-retropad-orch.md`, "utf8");

// 真pianist：不设 ORCH_PI_BIN（用真 pi bundle 入口），不设 ORCH_STUB_MODE
delete process.env.ORCH_PI_BIN;
delete process.env.ORCH_STUB_MODE;
delete process.env.ORCH_STUB_TELEMETRY;

const rt = buildRuntime({
	sheetText,
	cwd: CWD,
	model: "zai-coding-cn/glm-5.2",
	// 预算袋 90 分钟 → 双时钟自动上钟；总钟兜底交给 supervisor
});

if (DRY) {
	console.log("[dispatch-v2-2] dry-run：任务书解析 OK，角色表：", rt.sheet.roles.map((r) => `${r.role}×${r.count}`).join("、"));
	console.log("[dispatch-v2-2] 预算袋：", JSON.stringify(rt.sheet.budget));
	process.exit(0);
}

const taskId = `v2-2-${new Date().toISOString().slice(0, 10)}`;
console.log(`[dispatch-v2-2] 发车：${taskId}`);
const rec = rt.launchSheet({ taskId });
console.log(`[dispatch-v2-2] spawn：${rec.map((r) => `${r.minionId} pid=${r.pid} tier=${r.tier}`).join("；")}`);

// 常驻循环：心跳+看门+审批上浮全自动跑
rt.startLoop();
console.log("[dispatch-v2-2] 编排循环已启动（心跳双源+看门+审批上浮）。收工判据=收件箱交货单。");

// 等 END：交货单/讣告/等审通知 任一到达即收口
const t0 = Date.now();
const timer = setInterval(() => {
	rt.pollBeats();
	rt.sweep();
	const item = rt.inbox.peek();
	if (item) {
		console.log(`\n[dispatch-v2-2] 收件箱到达：${item.kind}（${item.payload?.minionId ?? "?"}）`);
		console.log(JSON.stringify(item.payload?.manifest ?? item.payload, null, 2).slice(0, 2000));
		const row = rt.ledger.get(item.payload?.minionId);
		console.log(`[dispatch-v2-2] 台账终态：${row?.status}（${Math.round((Date.now() - t0) / 1000)}s）`);
		rt.stop();
		clearInterval(timer);
		process.exit(0);
	}
	const rows = rt.ledger.all().map((r) => `${r.id}=${r.status}`);
	console.log(`[dispatch-v2-2] ${(Math.round((Date.now() - t0) / 1000))}s 台账：${rows.join(" ")} 心跳：${rt.ledger.all().map((r) => r.lastHeartbeat ? "✓" : "✗").join("")}`);
}, 30_000);
