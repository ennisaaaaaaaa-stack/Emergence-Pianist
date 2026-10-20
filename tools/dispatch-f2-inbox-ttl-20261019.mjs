#!/usr/bin/env node
// f2-inbox-ttl 发车脚本（2026-10-19 the author）：编排器真身发worker pianist跑 F2 收件箱按天清
// 用法：node tools/dispatch-f2-inbox-ttl-20261019.mjs [--dry-run]
// 串行表（hui #1088/#1090）：F3 已收口（61cb589），F2 排其后——本脚本即该单发车

import { buildRuntime } from "../src/orchestrator/index.mjs";
import fs from "node:fs";

const DRY = process.argv.includes("--dry-run");
const CWD = "/root/portalk-runtime";
const sheetText = fs.readFileSync(`${CWD}/data/casting-sheets/2026-10-19-f2-inbox-ttl.md`, "utf8");

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
	console.log("[dispatch-f2] dry-run：任务书解析 OK，角色表：", rt.sheet.roles.map((r) => `${r.role}×${r.count}`).join("、"));
	console.log("[dispatch-f2] 预算袋：", JSON.stringify(rt.sheet.budget));
	process.exit(0);
}

const taskId = `f2-inbox-ttl-${new Date().toISOString().slice(0, 10)}`;
console.log(`[dispatch-f2] 发车：${taskId}`);
const rec = rt.launchSheet({ taskId });
console.log(`[dispatch-f2] spawn：${rec.map((r) => `${r.minionId} pid=${r.pid} tier=${r.tier}`).join("；")}`);

// 常驻循环：心跳+看门+审批上浮全自动跑
rt.startLoop();
console.log("[dispatch-f2] 编排循环已启动（心跳双源+看门+审批上浮）。收工判据=收件箱交货单。");

// 等 END：只有交货单/讣告收车——审批卡是投递不是收工（2026-10-19 教训：老方子见任何条目即退，
// 发车 34s 就被壳里隔夜审批卡顶掉——F2 要治的病先把 F2 的发车顶了）。审批卡出声+出红区摘要。
const t0 = Date.now();
const timer = setInterval(() => {
	rt.pollBeats();
	rt.sweep();
	const item = rt.inbox.read();
	if (item) {
		if (item.kind === "交货单" || item.kind === "讣告") {
			console.log(`\n[dispatch-f2] 收件箱到达：${item.kind}（${item.payload?.minionId ?? "?"}）`);
			console.log(JSON.stringify(item.payload?.manifest ?? item.payload, null, 2).slice(0, 2000));
			const row = rt.ledger.get(item.payload?.minionId);
			console.log(`[dispatch-f2] 台账终态：${row?.status}（${Math.round((Date.now() - t0) / 1000)}s）`);
			rt.stop();
			clearInterval(timer);
			process.exit(0);
		}
		console.log(`[dispatch-f2] 审批卡投递（不收车）：${item.payload?.id} ${item.payload?.machineLine ?? ""} ${String(item.payload?.summary ?? "").slice(0, 80)}`);
	}
	const rows = rt.ledger.all().map((r) => `${r.id}=${r.status}`);
	console.log(`[dispatch-f2] ${Math.round((Date.now() - t0) / 1000)}s 台账：${rows.join(" ")} 心跳：${rt.ledger.all().map((r) => (r.lastHeartbeat ? "✓" : "✗")).join("")}`);
}, 30_000);
