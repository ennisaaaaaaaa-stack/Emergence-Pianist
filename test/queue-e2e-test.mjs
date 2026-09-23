// 施工④端到端测试：审批队列 + 写队列 + 通知环（真壳、真 HTTP、mock Grimoire）
// 验证链：
//   1. classify 三层：rm -rf→red / git commit→amber / ls→silent / grimoire_submit→red / spoor_journal→amber
//   2. 人话描述层：卡片 summary 含人话+自述，impact 不可逆标注
//   3. red 挂起：/tools/invoke 返回 deferred，不执行
//   4. pending 队列可见；decide deny → denied；重复 decide → 409 幂等
//   5. red 批准后执行：mock Grimoire 收到 POST /skill，卡片 result 回填
//   6. amber：立即执行 + 通知环留人话记录；/notify/since 增量拉取
//   7. 写队列：同 key 串行（B 开始时 A 已完成）、异 key 并行、失败不污染链
//   8. auto 模式：红区直通但审计落盘有痕（暗区不许无痕）
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { WriteQueue, classify, describe, impactOf, ApprovalQueue, NotifyRing } from "../src/queue-core.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pianist-q-test-"));
let pass = 0, total = 0;
function check(name, ok) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}`); }

// ---- mock Grimoire：记录收到的写请求，全 200 ----
const grimoirePosts = [];
const mockGrimoire = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		if (req.method === "POST") grimoirePosts.push({ path: req.url, body: Buffer.concat(chunks).toString("utf8") });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, mock: true }));
	});
});
await new Promise((ok) => mockGrimoire.listen(0, "127.0.0.1", ok));
const grimoirePort = mockGrimoire.address().port;

// ---- 起真壳（queue 模式）----
function spawnShell(port, extraEnv = {}) {
	const p = spawn("node", ["src/shell.mjs"], {
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			PIANIST_SHELL_PORT: String(port),
			GRIMOIRE_URL: `http://127.0.0.1:${grimoirePort}`,
			PIANIST_TELEMETRY_DIR: path.join(tmpDir, "tel"),
			PIANIST_AUDIT_FILE: path.join(tmpDir, "audit.jsonl"),
			...extraEnv,
		},
	});
	return p;
}
const shellPort = 41891;
const shellProc = spawnShell(shellPort);
await new Promise((r) => setTimeout(r, 800));
const shellUrl = `http://127.0.0.1:${shellPort}`;
const health = await (await fetch(`${shellUrl}/health`)).json();
check("shell up (queue mode)", health.ok === true);

// ---- 1) classify 三层 ----
check("classify: rm -rf → red", classify("bash", { command: "rm -rf /tmp/x" }) === "red");
check("classify: git commit → amber", classify("bash", { command: "git commit -m x" }) === "amber");
check("classify: ls → silent", classify("bash", { command: "ls -la" }) === "silent");
check("classify: grimoire_submit → red", classify("grimoire_submit", {}) === "red");
check("classify: spoor_journal → amber", classify("spoor_journal", {}) === "amber");
check("classify: grimoire_map → silent", classify("grimoire_map", {}) === "silent");

// ---- 2) 人话层 ----
const d = describe("grimoire_submit", { name: "test" }, "把今晚的坑记成书");
check("describe 人话+自述", d.includes("山海") && d.includes("自述：把今晚的坑记成书"));
const bi = impactOf("bash", { command: "rm -rf /data" });
check("impactOf 不可逆标注", bi.includes("删了就没了"));

// ---- 3) red 挂起 ----
const r1 = await (await fetch(`${shellUrl}/tools/invoke`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ action: "grimoire_submit", agent: "pianist-dev-1", intent: "测试投书", payload: { name: "test-skill" } }),
})).json();
check("red deferred", r1.deferred === true && typeof r1.approval?.id === "string");
check("卡片有人话", typeof r1.approval?.summary === "string" && r1.approval.summary.includes("山海"));
check("red 未执行（mock 零请求）", grimoirePosts.length === 0);

// ---- 4) pending + deny + 幂等 ----
const pend = await (await fetch(`${shellUrl}/approvals/pending`)).json();
check("pending 可见", pend.pending?.length === 1 && pend.pending[0].id === r1.approval.id);
const denyRes = await fetch(`${shellUrl}/approvals/decide`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ id: r1.approval.id, approve: false, by: "tester" }),
});
const denied = await denyRes.json();
check("deny 生效", denyRes.status === 200 && denied.status === "denied");
const again = await fetch(`${shellUrl}/approvals/decide`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ id: r1.approval.id, approve: true }),
});
check("重复裁决 409", again.status === 409);
check("deny 后仍零执行", grimoirePosts.length === 0);

// ---- 5) red 批准后执行 ----
const r2 = await (await fetch(`${shellUrl}/tools/invoke`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ action: "grimoire_submit", agent: "pianist-dev-1", intent: "真投一本", payload: { name: "real-skill" } }),
})).json();
const approveRes = await fetch(`${shellUrl}/approvals/decide`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ id: r2.approval.id, approve: true, by: "tester" }),
});
const approved = await approveRes.json();
check("批准后执行（mock 收到 POST /skill）", grimoirePosts.some((p) => p.path === "/skill"));
check("卡片 result 回填", approved.status === "executed" && typeof approved.result === "string");

// ---- 6) amber 通知 ----
const before = await (await fetch(`${shellUrl}/notify/since`)).json();
const baseCount = before.notifications.length;
const amberOut = await (await fetch(`${shellUrl}/tools/invoke`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ action: "grimoire_event", agent: "pianist-dev-1", intent: "记一笔", payload: { kind: "note" } }),
})).json();
check("amber 立即执行", amberOut?.status === 200 && !amberOut.deferred);
const after = await (await fetch(`${shellUrl}/notify/since`)).json();
check("通知环 +1 且是人话", after.notifications.length === baseCount + 1);
const lastN = after.notifications[after.notifications.length - 1];
check("通知含自述", lastN.summary.includes("自述：记一笔"));
const since = await (await fetch(`${shellUrl}/notify/since?after=${lastN.id}`)).json();
check("增量拉取（after 后零条）", since.notifications.length === 0);

// ---- 7) 写队列（单测）----
const wq = new WriteQueue();
const events = [];
await Promise.all([
	wq.run("k1", async () => { await new Promise((r) => setTimeout(r, 50)); events.push("A-done"); }),
	wq.run("k1", async () => { events.push("B-start-after-A:" + (events.includes("A-done"))); }),
	wq.run("k2", async () => { events.push("C-start"); }),
]);
await new Promise((r) => setTimeout(r, 30));
check("同 key 串行（B 等 A）", events.includes("B-start-after-A:true"));
check("异 key 并行（C 不等 A）", events.indexOf("C-start") < events.indexOf("A-done"));
const wq2 = new WriteQueue();
let poisoned = false, ranAfter = false;
await wq2.run("k", async () => { poisoned = true; throw new Error("boom"); }).catch(() => {});
await wq2.run("k", async () => { ranAfter = true; });
check("失败不污染链", poisoned && ranAfter);

// ---- 8) auto 模式：红区直通但审计有痕 ----
const autoPort = 41892;
const autoProc = spawnShell(autoPort, { PIANIST_APPROVAL_MODE: "auto" });
await new Promise((r) => setTimeout(r, 800));
const grimoireBefore = grimoirePosts.length;
const autoOut = await (await fetch(`http://127.0.0.1:${autoPort}/tools/invoke`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ action: "grimoire_submit", agent: "pianist-dev-1", intent: "auto 档测试", payload: { name: "auto-skill" } }),
})).json();
check("auto 红区直通", !autoOut.deferred && grimoirePosts.length === grimoireBefore + 1);
const audit = fs.existsSync(path.join(tmpDir, "audit.jsonl"))
	? fs.readFileSync(path.join(tmpDir, "audit.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
	: [];
check("auto 审计有痕（by=auto:auto）", audit.some((a) => a.by === "auto:auto"));
check("deny 审计有痕", audit.some((a) => a.approve === false && a.by === "tester"));
autoProc.kill();

shellProc.kill();
mockGrimoire.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
