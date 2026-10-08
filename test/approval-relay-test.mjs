// 分身审批上浮（the user 10/7 定案①②）端到端测试：真壳 + mock ExtensionAPI + 真收件箱 runtime。
// 验证链（对施工单验收标准逐条）：
//   主链：高危命令经 extension → 壳 /approvals/request 入队（卡片带非空 machineLine/plainLine/
//        commandHash）→ extension 返回 block 且 reason 含卡片 id+「放行一次」人话 → 人 decide(approve)
//        → 同命令重试放行（钩子非 block，卡片 consumedAt 落账）→ 第三次重试再入队新卡再 block（单次性钉死）
//   阴性一：壳不在场（URL 未设）→ 高危命令本地拦死 + 出声降级（不静默放行）
//   阴性二：上浮链路失败（health 够不着）→ 降级本地拦死 + 出声（上浮失败≠放行）
//   阴性三：拔掉 runtime pollApprovals 接线 → startLoop 跑着收件箱永无 kind=审批
//   阴性四：白卡入队（命中不了规则名）→ 500 拒绝，不产裸卡片
//   双行断言：pending/get 返回的卡片 machineLine 匹配 /\[(红区|灰区)\]/ 且 plainLine 非空
//   灰区不触发上浮（amber 维持现状：extension 只管红区）
//   commandHash 两侧同款（import 导出复算一致）
// 纪律：零真 pi（mock ExtensionAPI，真 pi 拉起数=0）、零真钱；审计/遥测/进度全指 tmp 夹具。
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";
import { commandHash, BASH_RED_RES } from "../src/queue-core.mjs";
import { buildRuntime } from "../src/orchestrator/runtime.mjs";

let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : (extra !== undefined ? " — " + extra : "")}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 3000) {
	const t0 = Date.now();
	while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(20); }
	return false;
}
/** 捕获 console.warn 出声（降级路径不许静默的断言面） */
async function captureWarns(fn) {
	const lines = [];
	const orig = console.warn;
	console.warn = (...a) => { lines.push(a.map(String).join(" ")); };
	try { return { out: await fn(), lines }; }
	finally { console.warn = orig; }
}

// ---- 夹具隔离：全指 tmp，不写生产 data/ ----
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pianist-approval-relay-"));

// ---- 起真壳（queue 模式；GRIMOIRE_URL 指死端口——本单链路不碰 grimoire 路由）----
// 端口随机（复验教训 2026-10-08）：固定端口 + 测试中途崩溃无清理 = 孤儿壳占端口，
// 下一轮 health 探到孤儿（旧内存状态）→ 整串假 FAIL。随机端口 + exit-hook 收尸双保险。
const shellPort = 20000 + Math.floor(Math.random() * 25000);
const shellProc = spawn("node", ["src/shell.mjs"], {
	stdio: ["ignore", "ignore", "inherit"],
	env: {
		...process.env,
		PIANIST_SHELL_PORT: String(shellPort),
		GRIMOIRE_URL: "http://127.0.0.1:41099",
		PIANIST_TELEMETRY_DIR: path.join(tmpDir, "tel"),
		PIANIST_AUDIT_FILE: path.join(tmpDir, "audit.jsonl"),
	},
});
const shellUrl = `http://127.0.0.1:${shellPort}`;
// 崩溃也收尸（复验教训 2026-10-08）：无 exit-hook 的 kill 只在正常走到尾才执行，
// 中途 TypeError 崩溃 = 孤儿壳。exit/uncaughtException 双钩兜底。
process.on("exit", () => { try { shellProc.kill(); } catch {} });
process.on("uncaughtException", (err) => {
	console.error("UNCAUGHT:", err);
	try { shellProc.kill(); } catch {}
	process.exit(1);
});
{
	let up = false;
	for (let i = 0; i < 50 && !up; i++) {
		try { const r = await fetch(`${shellUrl}/health`); up = r.ok; } catch { /* 还没起 */ }
		if (!up) await sleep(100);
	}
	check("真壳起得来（/health 通）", up);
	if (!up) { shellProc.kill(); console.log("BLOCKED:壳起不来，无法继续"); process.exit(1); }
}

// ---- 挂 extension（mock ExtensionAPI；AGENT_ID 钉在 import 前，壳 URL 调用时读 env）----
process.env.PIANIST_AGENT_ID = "pianist-relay-1";
process.env.PIANIST_SHELL_URL = shellUrl;
const AGENT = "pianist-relay-1";
const hooks = {};
{
	const pi = {
		on: (name, fn) => { (hooks[name] ??= []).push(fn); },
		registerTool: () => {},
		appendEntry: () => {},
	};
	const jiti = createJiti(import.meta.url);
	const mod = await jiti.import("../extensions/pianist-tools.ts");
	mod.default(pi);
}
/** 直调审批钩子（真机字段 input 优先，args 兜底——与 extension 读取面一致） */
const bashHook = (command) => hooks["tool_call"][0]({ toolName: "bash", input: { command } }, {});

const pending = async () => (await (await fetch(`${shellUrl}/approvals/pending`)).json()).pending;
const getCard = async (id) => await (await fetch(`${shellUrl}/approvals/get?id=${id}`)).json();
const decide = async (id, approve) => await (await fetch(`${shellUrl}/approvals/decide`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ id, approve, by: "tester" }),
})).json();
const cardIdFromReason = (reason) => (/卡片 (ap_[a-z0-9_]+)/.exec(String(reason)) ?? [])[1];

// ============ 主链：上浮 → 双行卡片 → block 人话 → 批准 → 单次放行 → 单次性钉死 ============
const CMD = "git push --force origin main";
let r1;
{
	r1 = await bashHook(CMD);
	check("高危命令 block（上浮）", r1?.block === true, JSON.stringify(r1));
	const id1 = cardIdFromReason(r1?.reason);
	check("block reason 带卡片 id", typeof id1 === "string" && id1.startsWith("ap_"), String(r1?.reason));
	check("block reason 带「放行一次」人话", String(r1?.reason).includes("放行一次") && String(r1?.reason).includes("BLOCKED:环境"));

	const pend = await pending();
	const card = pend.find((c) => c.id === id1);
	check("pending 可见（壳收到 /approvals/request：agent/command 署名过线）",
		!!card && card.agent === AGENT && card.raw?.payload?.command === CMD && card.origin === "request");
	// 防连锁崩（复验教训 2026-10-08）：card 缺席时后续裸访问会 TypeError 崩溃测试进程。
	// 首因断言已红，这里补一条「卡片缺席」的明确 FAIL 后 early-return 段落。
	if (!card) {
		check("卡片在场可继续（缺席时明确报红不崩溃）", false, `卡片 ${id1} 不在 pending`);
		check("机器行：`[红区|灰区] 规则名`（改写远端历史）", false, "卡片缺席");
		check("机器行匹配 /\\[(红区|灰区)\\]/", false, "卡片缺席");
		check("白话行非空（describe 人话）", false, "卡片缺席");
		check("commandHash=sha256 前 16 hex 且与 import 同款函数复算一致", false, "卡片缺席");
		check("/approvals/get 同样带双行", false, "卡片缺席");
	} else {
	check("机器行：`[红区|灰区] 规则名`（改写远端历史）", card?.machineLine === "[红区] 改写远端历史", String(card?.machineLine));
	check("机器行匹配 /\\[(红区|灰区)\\]/", /\[(红区|灰区)\]/.test(String(card?.machineLine ?? "")));
	check("白话行非空（describe 人话）", typeof card?.plainLine === "string" && card.plainLine.length > 0, String(card?.plainLine));
	check("commandHash=sha256 前 16 hex 且与 import 同款函数复算一致",
		/^[0-9a-f]{16}$/.test(String(card?.commandHash ?? "")) && card?.commandHash === commandHash(CMD));

	const got = await getCard(id1);
	check("/approvals/get 同样带双行", got?.machineLine === card.machineLine && got?.plainLine === card.plainLine && got?.consumedAt === null);

	// 人批准：不代跑（result=待重试人话），只置状态
	const approved = await decide(id1, true);
	check("decide approve：壳不代跑，result=「已批待分身重试（单次放行）」",
		approved?.status === "executed" && approved?.result === "已批待分身重试（单次放行）", JSON.stringify(approved?.result));

	// 同命令重试：放行一次（钩子非 block），卡片 consumedAt 落账
	const r2 = await bashHook(CMD);
	check("已批同命令重试放行（非 block）", r2 === undefined, JSON.stringify(r2));
	const consumed = await getCard(id1);
	check("卡片 consumedAt 落账（单次性记账）", typeof consumed?.consumedAt === "string" && consumed.consumedAt.length > 0);

	// 第三次重试：再入队新卡片再 block（单次性钉死）
	const r3 = await bashHook(CMD);
	const id3 = cardIdFromReason(r3?.reason);
	check("第三次重试再 block 且是新卡片（单次性钉死）",
		r3?.block === true && typeof id3 === "string" && id3 !== id1, JSON.stringify(r3?.reason));
	check("新卡片 pending 在队且未消费", (await pending()).some((c) => c.id === id3 && !c.consumedAt));

	// 留给 runtime 段用：把 id3 记出来
	globalThis.__cardId3 = id3;
	} // end of 主链段（card 缺席 early-FAIL 分支的 else 闭合）
}
const cardId3 = globalThis.__cardId3;

// ============ 阴性四：白卡入队（命中不了规则名）→ 500，不产裸卡片 ============
{
	const before = (await pending()).length;
	const res = await fetch(`${shellUrl}/approvals/request`, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ agent: AGENT, action: "bash", payload: { command: "ls -la" } }),
	});
	const body = await res.json();
	check("白卡入队 500 拒绝（fail-fast）", res.status === 500 && String(body?.error ?? "").includes("规则名"), `${res.status} ${JSON.stringify(body)}`);
	check("白卡不产裸卡片（pending 不增）", (await pending()).length === before);
}

// ============ 灰区不触发上浮（amber 维持现状：extension 只管红区）============
{
	const before = (await pending()).length;
	const r = await bashHook("git commit -m x"); // 灰区（git 写操作）
	check("灰区不 block", r === undefined, JSON.stringify(r));
	check("灰区不入队（pending 不增）", (await pending()).length === before);
}

// ============ 阴性二：上浮链路失败（health 够不着）→ 降级本地拦死 + 出声 ============
{
	const prev = process.env.PIANIST_SHELL_URL;
	process.env.PIANIST_SHELL_URL = "http://127.0.0.1:1"; // 死端口：health 连不上
	const { out, lines } = await captureWarns(() => bashHook("rm -rf /tmp/relay-dead-port"));
	process.env.PIANIST_SHELL_URL = prev;
	check("上浮失败仍 block（本地拦死）", out?.block === true && String(out?.reason).includes("本地拦死"), JSON.stringify(out));
	check("上浮失败出声降级（warn 非静默）", lines.length === 1 && lines[0].includes("pianist-approval"), JSON.stringify(lines));
}

// ============ 阴性一：壳不在场（URL 未设）→ 本地拦死 + 出声 ============
{
	const prev = process.env.PIANIST_SHELL_URL;
	delete process.env.PIANIST_SHELL_URL;
	const { out, lines } = await captureWarns(() => bashHook("git reset --hard HEAD~1"));
	process.env.PIANIST_SHELL_URL = prev;
	check("壳不在场仍 block（本地拦死）", out?.block === true, JSON.stringify(out));
	check("壳不在场出声降级（warn 非静默）", lines.length === 1 && lines[0].includes("PIANIST_SHELL_URL 未设"), JSON.stringify(lines));
}

// ============ runtime pollApprovals：pending 卡 → 收件箱 kind=审批（payload=卡片本体含双行）============
const sheetText = `# 审批上浮夹具书
背景与边界：夹具，零真钱
预算袋：时长 30 分钟
角色表：
  - 角色:施工分身 | 数量:1 | 沙箱:无
交付物清单：
  - 无
验收标准：
  - 审批轮各自归账
纪律：
  - 不 commit 留工作区`;
const rtOpts = {
	sheetText,
	progressDir: path.join(tmpDir, "progress"),
	telemetryDir: path.join(tmpDir, "tel"),
	sessionsDir: path.join(tmpDir, "sessions"),
	supervisorCfg: { timeoutMs: 600_000 },
};
const allRuntimes = [];
{
	const rt = buildRuntime({ ...rtOpts, shellUrl });
	allRuntimes.push(rt);
	await rt.pollApprovals();
	const items = rt.inbox.peekAll();
	check("pollApprovals：pending 卡入收件箱 kind=审批", items.length === 1 && items[0].kind === "审批" && items[0].payload?.id === cardId3, JSON.stringify(items.map((i) => i.payload?.id)));
	check("收件箱 payload=卡片本体（双行在内）", /\[(红区|灰区)\]/.test(String(items[0].payload?.machineLine)) && typeof items[0].payload?.plainLine === "string");
	await rt.pollApprovals();
	check("同 id 只投一次（去重）", rt.inbox.size() === 1);

	// 裁决后 pending 消失不追投裁决结果（裁决面归人，v0 不回环）
	await decide(cardId3, false);
	await rt.pollApprovals();
	check("裁决后不追投（收件箱不增）", rt.inbox.size() === 1);
}

// ============ startLoop 接线（阳性）：新 pending 卡经 tick 自动入收件箱 ============
{
	const rt = buildRuntime({ ...rtOpts, shellUrl });
	allRuntimes.push(rt);
	const r = await bashHook("rm -rf /tmp/relay-loop-wiring");
	const idNew = cardIdFromReason(r?.reason);
	check("接线前情：新卡已入壳 pending", (await pending()).some((c) => c.id === idNew));
	rt.startLoop(40);
	const arrived = await waitFor(() => rt.inbox.peekAll().some((i) => i.payload?.id === idNew), 3000);
	rt.stop();
	check("startLoop 接线：tick 自动拉卡入收件箱", arrived);
}

// ============ 阴性三：拔掉 pollApprovals 接线 → startLoop 跑着收件箱永无 kind=审批 ============
{
	const rt = buildRuntime({ ...rtOpts, shellUrl, pollApprovals: false });
	allRuntimes.push(rt);
	rt.startLoop(30);
	await sleep(300);
	const kinds = rt.inbox.peekAll().map((i) => i.kind);
	rt.stop();
	check("拔接线：壳在场有 pending 卡，收件箱也永无 kind=审批", !kinds.includes("审批"), JSON.stringify(kinds));
}

// ============ 壳不在场的 runtime：静默跳过出声一次（不刷屏）============
{
	const rt = buildRuntime({ ...rtOpts, shellUrl: "http://127.0.0.1:1" });
	allRuntimes.push(rt);
	const { lines } = await captureWarns(async () => {
		await rt.pollApprovals();
		await rt.pollApprovals();
	});
	check("壳不在场：两轮只出声一次", lines.length === 1 && lines[0].includes("审批轮询够不着壳"), JSON.stringify(lines));
	check("壳不在场：收件箱零审批", rt.inbox.size() === 0);
}

// ============ 直连面：intent 自述过线进白话行（body 带 intent 的通道钉子）============
{
	const res = await fetch(`${shellUrl}/approvals/request`, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ agent: AGENT, action: "bash", payload: { command: "git reset --hard HEAD~3" }, intent: "回滚误提交" }),
	});
	const out = await res.json();
	check("直连带 intent：白话行前置自述", res.status === 200 && out?.approval?.plainLine?.includes("自述：回滚误提交"), JSON.stringify(out?.approval?.plainLine));
	if (out?.approval?.id) await decide(out.approval.id, false); // 收尾：不留悬案
}

// ============ 单一事实源形状：BASH_RED_RES 逐条带规则名（extension import 同一份）============
check("BASH_RED_RES 形状 {re,name} 且名字全非空", BASH_RED_RES.every((r) => r instanceof RegExp === false && r?.re instanceof RegExp && typeof r?.name === "string" && r.name.length > 0));

for (const rt of allRuntimes) rt.stop();
shellProc.kill();
await sleep(100);
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
