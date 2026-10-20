#!/usr/bin/env node
// style-b 发车：pianist工具迭代单（向风格画+自长笔刷），单发
// 用法：node tools/dispatch-style-b.mjs [--dry-run]
// 形状沿用 dispatch-dual-20261012.mjs 的监督循环（交货单/讣告收口，审批出声不代批）

import { buildRuntime } from "../src/orchestrator/index.mjs";
import fs from "node:fs";

const DRY = process.argv.includes("--dry-run");
const CWD = "/root/portalk-runtime";

// 真pianist：不设 stub
delete process.env.ORCH_PI_BIN;
delete process.env.ORCH_STUB_MODE;
delete process.env.ORCH_STUB_TELEMETRY;

const SHEET = {
	name: "style-b",
	file: `${CWD}/data/casting-sheets/2026-10-12-tool-iteration-b.md`,
};

const sheetText = fs.readFileSync(SHEET.file, "utf8");
const rt = buildRuntime({ sheetText, cwd: CWD, model: "zai-coding-cn/glm-5.2" });

if (DRY) {
	console.log(`[style-b dry] 解析 OK，角色表 ${rt.sheet.roles.map((r) => `${r.role}×${r.count ?? 1}`).join("、")}，预算袋 ${JSON.stringify(rt.sheet.budget)}`);
	process.exit(0);
}

let done = false;
const t0 = Date.now();
const taskId = `style-b-${new Date().toISOString().slice(10, 19).replace(/:/g, "")}`;
const rec = rt.launchSheet({ taskId });
console.log(`[style-b] 发车：${rec.map((r) => `${r.minionId} pid=${r.pid} tier=${r.tier}`).join("；")}`);
rt.startLoop();

const timer = setInterval(() => {
	rt.pollBeats();
	rt.sweep();
	for (let guard = 0; guard < 10; guard++) {
		const item = rt.inbox.read();
		if (!item) break;
		const p = item.payload ?? {};
		if (item.kind === "交货单" || item.kind === "讣告") {
			console.log(`\n[style-b] ${item.kind}（${p.minionId ?? "?"}）`);
			console.log(JSON.stringify(p.manifest ?? p, null, 2).slice(0, 1500));
			const row = rt.ledger.get(p.minionId);
			console.log(`[style-b] 台账终态：${row?.status}`);
			done = true;
		} else if (item.kind === "审批") {
			console.log(`[style-b][审批上浮] ${p.machineLine ?? ""}\n            ${p.plainLine ?? ""} —— 出声等待人工裁决，不代批`);
		} else {
			console.log(`[style-b][通知] ${JSON.stringify(p).slice(0, 300)}`);
		}
	}
	const rows = rt.ledger.all();
	console.log(`[style-b] ${Math.round((Date.now() - t0) / 1000)}s | ${done ? "DONE" : rows.map((r) => r.status).join(",")}${rows.map((r) => (r.lastHeartbeat ? "✓" : "✗")).join("")}`);
	if (done) {
		console.log("[style-b] 收口，退出。");
		rt.stop();
		clearInterval(timer);
		process.exit(0);
	}
	if (Date.now() - t0 > 65 * 60 * 1000) {
		console.log("[style-b] 监督窗 65min 到，未收口，退出（哨兵会接着判）。");
		rt.stop();
		clearInterval(timer);
		process.exit(2);
	}
}, 30_000);
