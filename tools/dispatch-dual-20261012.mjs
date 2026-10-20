#!/usr/bin/env node
// 双发发车脚本：schedule + brush 两单并行——编排器多任务调度首测（2026-10-12）
// 用法：node tools/dispatch-dual-20261012.mjs [--dry-run]
// 形状：一单一 runtime（buildRuntime 收 sheetText）；监督循环收口判据修正版——
//   只认 交货单/讣告 计数退出；审批 出声不代批不退出；通知 出声继续。
// 收口判据是 v2-2 的坑（10/10）：审批上浮即 exit = 监督链死在审批上。

import { buildRuntime } from "../src/orchestrator/index.mjs";
import fs from "node:fs";

const DRY = process.argv.includes("--dry-run");
const CWD = "/root/portalk-runtime";

// 真pianist：不设 stub
delete process.env.ORCH_PI_BIN;
delete process.env.ORCH_STUB_MODE;
delete process.env.ORCH_STUB_TELEMETRY;

const SHEETS = [
	{ name: "schedule-bone", file: `${CWD}/data/casting-sheets/2026-10-12-schedule-bone.md` },
	{ name: "brush-first-draw", file: `${CWD}/data/casting-sheets/2026-10-12-brush-first-draw.md` },
];

const rts = SHEETS.map((s) => {
	const sheetText = fs.readFileSync(s.file, "utf8");
	return {
		name: s.name,
		rt: buildRuntime({ sheetText, cwd: CWD, model: "zai-coding-cn/glm-5.2" }),
		done: false,
	};
});

if (DRY) {
	for (const { name, rt } of rts) {
		console.log(`[dual-dry] ${name}：解析 OK，角色表 ${rt.sheet.roles.map((r) => `${r.role}×${r.count ?? 1}`).join("、")}，预算袋 ${JSON.stringify(rt.sheet.budget)}`);
	}
	process.exit(0);
}

const t0 = Date.now();
for (const { name, rt } of rts) {
	const taskId = `${name}-${new Date().toISOString().slice(10, 19).replace(/:/g, "")}`;
	const rec = rt.launchSheet({ taskId });
	console.log(`[dual] 发车 ${name}：${rec.map((r) => `${r.minionId} pid=${r.pid} tier=${r.tier}`).join("；")}`);
	rt.startLoop();
}

const timer = setInterval(() => {
	for (const e of rts) {
		if (e.done) continue;
		e.rt.pollBeats();
		e.rt.sweep();
		// read() 出队语义：逐条消费，交货单/讣告 收口；审批/通知 出声继续
		for (let guard = 0; guard < 10; guard++) {
			const item = e.rt.inbox.read();
			if (!item) break;
			const p = item.payload ?? {};
			if (item.kind === "交货单" || item.kind === "讣告") {
				console.log(`\n[dual:${e.name}] ${item.kind}（${p.minionId ?? "?"}）`);
				console.log(JSON.stringify(p.manifest ?? p, null, 2).slice(0, 1500));
				const row = e.rt.ledger.get(p.minionId);
				console.log(`[dual:${e.name}] 台账终态：${row?.status}`);
				e.done = true;
			} else if (item.kind === "审批") {
				console.log(`[dual:${e.name}][审批上浮] ${p.machineLine ?? ""}\n            ${p.plainLine ?? ""} —— 出声等待人工裁决，不代批`);
			} else {
				console.log(`[dual:${e.name}][通知] ${JSON.stringify(p).slice(0, 300)}`);
			}
		}
	}
	const states = rts.map((e) => {
		const rows = e.rt.ledger.all();
		return `${e.name}:${e.done ? "DONE" : rows.map((r) => `${r.status}`).join(",")}${rows.map((r) => (r.lastHeartbeat ? "✓" : "✗")).join("")}`;
	});
	console.log(`[dual] ${Math.round((Date.now() - t0) / 1000)}s | ${states.join(" | ")}`);
	if (rts.every((e) => e.done)) {
		console.log("[dual] 全部收口，退出。");
		for (const e of rts) e.rt.stop();
		clearInterval(timer);
		process.exit(0);
	}
	if (Date.now() - t0 > 100 * 60 * 1000) {
		console.log("[dual] 监督窗 100min 到，未全收口，退出（哨兵会接着判）。");
		for (const e of rts) e.rt.stop();
		clearInterval(timer);
		process.exit(2);
	}
}, 30_000);
