// 施工③第一步端到端测试：extension 遥测钩子 → /telemetry/ingest → JSONL 落盘
// 验证链路（真 HTTP，无 mock fetch）：
//   1. 批量阈值触发：攒满 TELEMETRY_BATCH=25 条自动冲刷
//   2. settled 兜底：buffer 有剩没攒满时冲刷
//   3. 落盘形状：JSONL 行、按 agent 分文件按天命名、v:1
//   4. 壳不在场：事件丢弃不炸（可拆卸性）
//   5. 大事件丢弃：>32KB 的事件被壳拒收
//   6. 恶意形状：非数组 events → 400
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pianist-tel-test-"));
const received = [];

// ---- 起 shell.mjs 真实例（PIANIST_TELEMETRY_DIR 指临时目录，端口随机）----
const shellPort = 41880;
process.env.PIANIST_TELEMETRY_DIR = tmpDir;
process.env.PIANIST_SHELL_PORT = String(shellPort);
process.env.PIANIST_SHELL_URL = `http://127.0.0.1:${shellPort}`;
const shellProc = spawn("node", ["src/shell.mjs"], {
	stdio: ["ignore", "pipe", "pipe"],
	env: { ...process.env },
});
await new Promise((r) => setTimeout(r, 800)); // 等 listen
const health = await (await fetch(`http://127.0.0.1:${shellPort}/health`)).json();
console.log("shell up:", health.ok === true);

// ---- 加载 extension（读 env → 指向真壳）----
const hooks = {};
const pi = {
	on: (name, fn) => { (hooks[name] ??= []).push(fn); },
	registerTool: () => {},
	appendEntry: () => {},
};
const jiti = createJiti(import.meta.url);
const mod = await jiti.import("../extensions/pianist-tools.ts");
mod.default(pi);
console.log("telemetry hooks wired:", ["tool_execution_start", "tool_execution_end", "message_end", "agent_settled", "session_shutdown"].every(k => hooks[k]));

// ---- 1) 攒满 25 条自动冲刷 ----
for (let i = 0; i < 25; i++) {
	await hooks["tool_execution_start"][0]({ toolCallId: `t${i}`, toolName: "read", args: { path: "/tmp/x" } });
	await hooks["tool_execution_end"][0]({ toolCallId: `t${i}`, toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
}
await new Promise((r) => setTimeout(r, 500)); // 等 flush HTTP 完成
const day = new Date().toISOString().slice(0, 10);
const file = path.join(tmpDir, `pianist-dev-1-${day}.jsonl`);
const lines1 = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
const batchFlushed = lines1.length === 25;
console.log("batch flush at 25:", batchFlushed);

// ---- 2) settled 兜底：3 条没攒满，settled 冲刷 ----
for (let i = 100; i < 103; i++) {
	await hooks["tool_execution_start"][0]({ toolCallId: `t${i}`, toolName: "bash", args: { command: "ls" } });
	await hooks["tool_execution_end"][0]({ toolCallId: `t${i}`, toolName: "bash", result: { content: [{ type: "text", text: "x" }] }, isError: false });
}
await hooks["agent_settled"][0]({}, {});
await new Promise((r) => setTimeout(r, 500));
const lines2 = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
const settledFlushed = lines2.length === 28;
console.log("settled tail flush:", settledFlushed);

// ---- 3) 落盘形状 ----
const ev = JSON.parse(lines2[0]);
const shapeOk = ev.v === 1 && ev.agent === "pianist-dev-1" && ev.kind === "tool_use"
	&& typeof ev.ts === "string" && ev.data.tool === "read" && ev.data.durationMs !== undefined
	&& ev.data.resultBytes > 0;
console.log("line shape (v1/tool_use):", shapeOk);

// ---- 4) 壳不在场：丢弃不炸 ----
process.env.PIANIST_SHELL_URL = "";
for (let i = 200; i < 205; i++) {
	await hooks["tool_execution_start"][0]({ toolCallId: `t${i}`, toolName: "read", args: {} });
	await hooks["tool_execution_end"][0]({ toolCallId: `t${i}`, toolName: "read", result: { content: [] }, isError: true });
}
await hooks["agent_settled"][0]({}, {});
await new Promise((r) => setTimeout(r, 300));
const lines3 = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
console.log("no-shell drop (no new lines):", lines3.length === 28);
process.env.PIANIST_SHELL_URL = `http://127.0.0.1:${shellPort}`;

// ---- 5) message_end 事件（usage 通道）+ session_shutdown 冲刷 ----
await hooks["message_end"][0]({ message: { role: "assistant", usage: { input: 100, output: 50, totalTokens: 150, cost: { total: 0.001 } } } }, {});
await hooks["session_shutdown"][0]({}, {});
await new Promise((r) => setTimeout(r, 500));
const lines4 = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
const last = JSON.parse(lines4[lines4.length - 1]);
const usageOk = last.kind === "message_end" && last.data.usage?.totalTokens === 150;
console.log("message_end usage logged:", usageOk);

// ---- 6) 大事件丢弃 + 恶意形状 ----
const big = "x".repeat(40_000);
const r1 = await fetch(`http://127.0.0.1:${shellPort}/telemetry/ingest`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ agent: "pianist-dev-1", events: [{ v: 1, ts: new Date().toISOString(), agent: "pianist-dev-1", kind: "tool_use", data: { blob: big } }] }),
});
const j1 = await r1.json();
console.log("oversize dropped (written=0):", j1.written === 0);
const r2 = await fetch(`http://127.0.0.1:${shellPort}/telemetry/ingest`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ agent: "x", events: "not-array" }),
});
console.log("bad shape rejected 400:", r2.status === 400);

shellProc.kill();
fs.rmSync(tmpDir, { recursive: true, force: true });
const checks = [batchFlushed, settledFlushed, shapeOk, lines3.length === 28, usageOk, j1.written === 0, r2.status === 400];
console.log("PASS " + checks.filter(Boolean).length + "/7");
process.exit(checks.every(Boolean) ? 0 : 1);
