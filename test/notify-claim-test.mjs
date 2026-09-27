// T3 端到端测试：notify_claim 认领报备动作 + 通知环投递（真壳、真 HTTP）
// 验证链：
//   1. 分层：classify("notify_claim") === silent——不进审批队列、不进写队列（红灰区语义都不沾）
//   2. 人话表：describe 含「分身认领报备」（ACTION_HUMAN 行）
//   3. /tools/invoke notify_claim → { ok: true, notificationId }，非 deferred
//   4. push 后 /notify/since 实查有该条：agent/summary/ticket/action 字段齐
//   5. 不进审批队列：/approvals/pending 全程零增长
//   6. 缺 summary → HTTP 400 形状错误不静默，且通知环零增长；ticket 非字符串同判 400
//   7. 幂等不要求：同一认领可重发——两条独立通知，notificationId 不同
//   8. 通知环容量 200 不变（溢出丢最旧）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { NotifyRing, classify, describe } from "../src/queue-core.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pianist-notify-claim-"));
let pass = 0, total = 0;
function check(name, ok) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}`); }

// ---- 1) 分层与人话表（单测）----
check("classify: notify_claim → silent", classify("notify_claim", { summary: "认领 T9", ticket: "T9" }) === "silent");
check("describe 人话行「分身认领报备」", describe("notify_claim", { summary: "x" }).includes("分身认领报备"));

// ---- 起真壳（notify_claim 是壳本地动作，无外部提供者依赖，不必 mock）----
const shellPort = 41895;
const shellProc = spawn("node", ["src/shell.mjs"], {
	stdio: ["ignore", "pipe", "pipe"],
	env: {
		...process.env,
		PIANIST_SHELL_PORT: String(shellPort),
		PIANIST_TELEMETRY_DIR: path.join(tmpDir, "tel"),
		PIANIST_AUDIT_FILE: path.join(tmpDir, "audit.jsonl"),
	},
});
await new Promise((r) => setTimeout(r, 800));
const shellUrl = `http://127.0.0.1:${shellPort}`;
const health = await (await fetch(`${shellUrl}/health`)).json();
check("shell up", health.ok === true);

// ---- 3) 报备一次 ----
const notifyBefore = (await (await fetch(`${shellUrl}/notify/since`)).json()).notifications.length;
const pendingBefore = (await (await fetch(`${shellUrl}/approvals/pending`)).json()).pending.length;
const claimRes = await fetch(`${shellUrl}/tools/invoke`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({
		action: "notify_claim",
		agent: "pianist-dev-1",
		payload: { summary: "认领 T3 施工：认领报备动作+通知环投递接线", ticket: "T3" },
	}),
});
const claim = await claimRes.json();
check("报备返回 { ok, notificationId }", claimRes.status === 200 && claim.ok === true && typeof claim.notificationId === "string");
check("非 deferred（silent 不挂审批）", claim.deferred !== true);

// ---- 5) 不进审批队列 ----
const pendingAfter = (await (await fetch(`${shellUrl}/approvals/pending`)).json()).pending.length;
check("审批队列零增长", pendingAfter === pendingBefore);

// ---- 4) /notify/since 实查有该条（agent/summary/ticket 字段齐）----
const sinceAll = await (await fetch(`${shellUrl}/notify/since`)).json();
check("通知环 +1", sinceAll.notifications.length === notifyBefore + 1);
const n = sinceAll.notifications.find((x) => x.id === claim.notificationId);
check("查到该条：agent 字段", !!n && n.agent === "pianist-dev-1");
check("查到该条：summary 是自述原话", !!n && n.summary === "认领 T3 施工：认领报备动作+通知环投递接线");
check("查到该条：ticket 字段", !!n && n.ticket === "T3");
check("查到该条：action 位标 notify_claim", !!n && n.action === "notify_claim");
const inc = await (await fetch(`${shellUrl}/notify/since?after=${claim.notificationId}`)).json();
check("增量拉取（after 后零条）", inc.notifications.length === 0);

// ---- 6) 形状错 → 400 不静默，且零通知增长 ----
const bad1 = await fetch(`${shellUrl}/tools/invoke`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ action: "notify_claim", agent: "pianist-dev-1", payload: { ticket: "T3" } }),
});
const bad1Body = await bad1.json();
check("缺 summary → HTTP 400", bad1.status === 400 && typeof bad1Body.error === "string" && bad1Body.error.includes("summary"));
const bad2 = await fetch(`${shellUrl}/tools/invoke`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ action: "notify_claim", agent: "pianist-dev-1", payload: { summary: "x", ticket: 42 } }),
});
check("ticket 非字符串 → HTTP 400", bad2.status === 400);
const notifyAfterBad = (await (await fetch(`${shellUrl}/notify/since`)).json()).notifications.length;
check("形状错零通知增长（不静默入环）", notifyAfterBad === notifyBefore + 1);

// ---- 7) 幂等不要求：同一认领可重发 ----
const againRes = await fetch(`${shellUrl}/tools/invoke`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({
		action: "notify_claim",
		agent: "pianist-dev-1",
		payload: { summary: "认领 T3 施工：认领报备动作+通知环投递接线", ticket: "T3" },
	}),
});
const again = await againRes.json();
check("重发成功且 id 不同（幂等不要求）", againRes.status === 200 && again.ok === true && again.notificationId !== claim.notificationId);
const notifyFinal = (await (await fetch(`${shellUrl}/notify/since`)).json()).notifications.length;
check("重发后通知环 +1（共 2 条）", notifyFinal === notifyBefore + 2);

// ---- 8) 容量 200 不变（单测）----
const ring = new NotifyRing(200);
for (let i = 0; i < 205; i++) ring.claim("a", `s${i}`, null);
check("通知环容量 200（溢出丢最旧）", ring.items.length === 200 && ring.items[0].summary === "s5");
check("ticket 可省（null 不炸）", ring.claim("a", "无牌号报备").ticket === null);

shellProc.kill();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`新增检查 ${total} 项，${pass === total ? "全绿" : "有红"}`);
console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
