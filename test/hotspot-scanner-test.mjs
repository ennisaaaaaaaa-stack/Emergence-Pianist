// 施工③第二步测试：聚合热点扫描器（纯函数级，spawn 真进程）
// 场景（对应设计文档 §3 闸门二 + §9 出声纪律）：
//   1. 重复×确定 → 热点（occurrences/convergence/evidence 形状）
//   2. burst 去重叠：单 burst 连跑不虚增计数
//   3. 确定性不足 → 拒（rejectedByConvergence 出声）
//   4. 会话边界切段：跨 session_mark 的窗口不配对（有对照无 mark 组）
//   5. 错误热点：同形状 isError 攒阈值单独成路
//   6. 出声台账：坏行计数、eventsParsed、usage 聚合
//   7. 目录不可读 → 退出码 1（拒绝静默空结果）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pianist-scan-test-"));
const day = new Date().toISOString().slice(0, 10);
const iso = () => new Date().toISOString();
const results = [];
function check(name, ok) { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name}`); }

const tu = (agent, tool, input, isError = false) => ({ v: 1, ts: iso(), agent, kind: "tool_use", data: { tool, input, isError, durationMs: 5, resultBytes: 10 } });
const mark = (agent) => ({ v: 1, ts: iso(), agent, kind: "session_mark", data: { note: "t" } });
const me = (agent, tokens) => ({ v: 1, ts: iso(), agent, kind: "message_end", data: { usage: { input: 10, output: 20, totalTokens: tokens, cost: { total: 0.001 } } } });

// ---- 1) 重复×确定：read→bash→edit ×4，形状全同 ----
const rLines = [];
for (let i = 0; i < 4; i++) {
	rLines.push(tu("r-agent", "read", { path: "/src/app.ts" }));
	rLines.push(tu("r-agent", "bash", { command: "npm test" }));
	rLines.push(tu("r-agent", "edit", { path: "/src/app.ts" }));
}
rLines.push(me("r-agent", 100), me("r-agent", 250));
fs.writeFileSync(path.join(tmp, `r-agent-${day}.jsonl`), rLines.map((l) => JSON.stringify(l)).join("\n") + "\n");

// ---- 2) burst：同工具连跑 6 次（窗口 3 → 有效出现只算 2，不够阈值 3）----
const bLines = [];
for (let i = 0; i < 6; i++) bLines.push(tu("b-agent", "read", { path: "/logs/x.log" }));
fs.writeFileSync(path.join(tmp, `b-agent-${day}.jsonl`), bLines.map((l) => JSON.stringify(l)).join("\n") + "\n");

// ---- 3) 确定性不足：同工具序列但 bash 命令每次结构不同 ----
const cmds = ["npm test", "git status", "curl http://q", "docker ps"];
const cLines = [];
for (const c of cmds) {
	cLines.push(tu("c-agent", "read", { path: "/src/app.ts" }));
	cLines.push(tu("c-agent", "bash", { command: c }));
	cLines.push(tu("c-agent", "edit", { path: "/src/app.ts" }));
}
// 坏行注入（给出声台账数）
cLines.push("{ not json", "", '{"v":1,"noKind":true}');
fs.writeFileSync(path.join(tmp, `c-agent-${day}.jsonl`), cLines.map((l) => typeof l === "string" ? l : JSON.stringify(l)).join("\n") + "\n");

// ---- 4) 边界切段：5 个 session 各 [read,bash]，mark 分隔 → 无窗口 ----
const sLines = [];
for (let i = 0; i < 5; i++) {
	sLines.push(tu("s-agent", "read", { path: "/a.ts" }));
	sLines.push(tu("s-agent", "bash", { command: "ls" }));
	sLines.push(mark("s-agent"));
}
fs.writeFileSync(path.join(tmp, `s-agent-${day}.jsonl`), sLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
// 对照组：同工具无 mark → 拼成流。×7 才够：交替流里 r|b|r 窗口位置 0,2,4,...，
// 去重叠（间隔≥W=3）后选 0,4,8 → 3 次（×5 只能选出 2 次，会被 occ 阈值正确拒掉）
const s2Lines = [];
for (let i = 0; i < 7; i++) {
	s2Lines.push(tu("s2-agent", "read", { path: "/a.ts" }));
	s2Lines.push(tu("s2-agent", "bash", { command: "ls" }));
}
fs.writeFileSync(path.join(tmp, `s2-agent-${day}.jsonl`), s2Lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

// ---- 5) 错误热点：bash deploy app 失败 ×4（夹着成功的 read）----
const eLines = [];
for (let i = 0; i < 4; i++) {
	eLines.push(tu("e-agent", "read", { path: "/cfg.yaml" }));
	eLines.push(tu("e-agent", "bash", { command: "deploy app" }, true));
}
fs.writeFileSync(path.join(tmp, `e-agent-${day}.jsonl`), eLines.map((l) => JSON.stringify(l)).join("\n") + "\n");

// ---- 跑 ----
const out = path.join(tmp, "report.json");
const run = spawnSync("node", ["src/hotspot-scanner.mjs", "--dir", tmp, "--out", out], { encoding: "utf8", cwd: "." });
check("scanner exits 0", run.status === 0);
if (run.status !== 0) { console.log(run.stdout, run.stderr); process.exit(1); }
const rep = JSON.parse(fs.readFileSync(out, "utf8"));

// ---- 1) ----
const rh = rep.hotspots.filter((h) => h.agent === "r-agent" && h.windowFp === "read|bash|edit");
check("repeat+converge hotspot found", rh.length === 1);
check("occurrences = 4", rh[0]?.occurrences === 4);
check("convergence = 1.0", rh[0]?.convergence === 1);
check("shapeVariants = 1", rh[0]?.shapeVariants === 1);
check("evidence has file+line", !!rh[0]?.evidence?.file && rh[0]?.evidence?.line > 0);

// ---- 2) ----
const bh = rep.hotspots.filter((h) => h.agent === "b-agent");
check("single burst not inflated (no hotspot at occ 2 < 3)", bh.length === 0);

// ---- 3) ----
const ch = rep.hotspots.filter((h) => h.agent === "c-agent");
check("low convergence rejected (no hotspot)", ch.length === 0);
check("rejection is voiced", rep.voice.rejectedByConvergence >= 1);

// ---- 4) ----
const sh = rep.hotspots.filter((h) => h.agent === "s-agent");
check("boundary cuts windows (marked: no hotspot)", sh.length === 0);
const s2h = rep.hotspots.filter((h) => h.agent === "s2-agent" && h.windowFp === "read|bash|read");
check("control without marks produces hotspot", s2h.length === 1 && s2h[0].occurrences === 3);

// ---- 5) ----
const eh = rep.errorHotspots.filter((h) => h.agent === "e-agent");
check("error hotspot (shape+count)", eh.length === 1 && eh[0].count === 4 && eh[0].shape.startsWith("bash::"));

// ---- 6) ----
check("parse errors counted (2)", rep.voice.parseErrors === 2);
const expEvents = rLines.length + bLines.length + (cLines.length - 3) + sLines.length + s2Lines.length + eLines.length;
check("eventsParsed matches", rep.voice.eventsParsed === expEvents);
check("usage aggregated", rep.totals.usageByAgent["r-agent"]?.calls === 2 && rep.totals.usageByAgent["r-agent"]?.totalTokens === 350);
check("sources listed per file", rep.sources.length === 6);

// ---- 7) ----
const bad = spawnSync("node", ["src/hotspot-scanner.mjs", "--dir", "/nonexistent-dir-xyz", "--out", "-"], { encoding: "utf8" });
check("unreadable dir exits 1 (refuse silent empty)", bad.status === 1);

fs.rmSync(tmp, { recursive: true, force: true });
const pass = results.filter(Boolean).length;
console.log(`PASS ${pass}/${results.length}`);
process.exit(pass === results.length ? 0 : 1);
