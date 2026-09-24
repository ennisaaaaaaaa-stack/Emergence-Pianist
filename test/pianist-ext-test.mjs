// pianist-tools 加载测试：mock ExtensionAPI，验证三件套钩子+桥工具注册
import http from "node:http";
import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

// 钉住测试前置环境：本仓开发机 ambient env 里飘着活壳 URL（如 …:8770）和别的 agent id
// （如 pianist-dev-2），会把“无壳降级/账本 agent/桥占位”断言带偏，还会把测试遥测写进真壳。
// AGENT_ID 在 extension 模块加载时读取，必须钉在首次 jiti.import 之前。
process.env.PIANIST_AGENT_ID = "pianist-dev-1";
delete process.env.PIANIST_SHELL_URL;

const hooks = {};
const tools = [];
const entries = [];
const pi = {
	on: (name, fn) => { (hooks[name] ??= []).push(fn); },
	registerTool: (t) => tools.push(t),
	appendEntry: (type, data) => entries.push({ type, data }),
};

const jiti = createJiti(import.meta.url);
const mod = await jiti.import("../extensions/pianist-tools.ts");
mod.default(pi);

/** 起一次性 mock 壳 HTTP 服务 + 带壳重导入 extension，返回 { hooks, tools, entries, close } */
async function withMockShell(fn, routes) {
	const srv = http.createServer((req, res) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			const r = routes[req.url] ?? routes["*"];
			res.writeHead(r?.status ?? 404, { "content-type": "application/json" });
			res.end(JSON.stringify(r?.status ? r : (r?.body ?? { error: "no route" })));
		});
	});
	await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
	const port = srv.address().port;
	const h2 = {}, t2 = [], e2 = [];
	const pi2 = {
		on: (name, f) => { (h2[name] ??= []).push(f); },
		registerTool: (t) => t2.push(t),
		appendEntry: (type, data) => e2.push({ type, data }),
	};
	const prevUrl = process.env.PIANIST_SHELL_URL;
	process.env.PIANIST_SHELL_URL = `http://127.0.0.1:${port}`;
	try {
		const jiti2 = createJiti(`${import.meta.url}#shell-${port}`);
		const mod2 = await jiti2.import("../extensions/pianist-tools.ts");
		mod2.default(pi2);
		return await fn(h2, t2, e2);
	} finally {
		if (prevUrl === undefined) delete process.env.PIANIST_SHELL_URL;
		else process.env.PIANIST_SHELL_URL = prevUrl;
		srv.close();
	}
}

console.log("hooks wired:", Object.keys(hooks).join(", "));
console.log("tools registered:", tools.map(t => t.name).join(", "));

// 1) 审批钩子：高危命令必须 block
const r1 = await hooks["tool_call"][0]({ toolName: "bash", args: { command: "rm -rf /tmp/x" } }, {});
console.log("approval blocks rm -rf:", r1?.block === true);

// 2) 审批钩子：普通命令放行
const r2 = await hooks["tool_call"][0]({ toolName: "bash", args: { command: "ls -la" } }, {});
console.log("approval passes ls:", r2 === undefined);

// 3) 记忆注入：新契约（9/20 施工②）——壳不在场时返回 undefined（不阻塞），
//    壳在场时注入 user 角色经图消息（Pi 的 Message 联合无 system role）。
//    mock 环境无真实壳 → 这里验证降级路径：context 钩子不炸、原消息不动。
const r3 = await hooks["context"][0]({ messages: [{ role: "user", content: "hi" }] }, {});
console.log("context degrades to pass-through when no shell:", r3 === undefined);

// 3b) 有壳路径单独测：真起一个 mock 壳 HTTP 服务，env 指过去（extension 调用时读 env），
//     验证注入形状（user 角色 + 经图标记 + 原消息保留）
const r3b = await withMockShell(async () => {
	return hooks["context"][0]({ messages: [{ role: "user", content: "hi" }] }, {});
}, {
	"/tools/invoke": { status: 200, body: "# 经图 (Skill Map)\nmock" },
});
console.log("map injected as user msg:", r3b?.messages?.[0]?.role === "user" && String(r3b.messages[0].content).includes("技能经图（Grimoire）"));
console.log("original kept:", r3b?.messages?.length === 2 && r3b.messages[1].content === "hi");

// 4) 账本桥：session_start 落 appendEntry（同一事件上有两个 handler，全跑）
for (const h of hooks["session_start"]) await h({}, {});
console.log("ledger entry:", entries[0]?.type === "pianist.session_start" && entries[0]?.data.agent === "pianist-dev-1");

// 5) 桥工具：未接线占位
const out = await tools[0].execute("t1", { action: "test" }, undefined, undefined, {});
console.log("bridge stub:", out.details.wired === false && out.content[0].text.includes("PIANIST_SHELL_URL"));

// 6) 洞1：壳在场 + ingest 503 → 丢弃必须出声（warn+计数+session 汇总），且不抛错
const r6 = await withMockShell(async (h2) => {
	// 灌 3 条遥测（tool_execution_end→enqueue），攒不到 25 条批量线，靠 settled 兜底冲刷
	for (const h of h2["tool_execution_end"]) await h({ toolCallId: "t1", toolName: "bash", isError: false });
	await h2["agent_settled"][0]();
	// 丢弃已有 warn 出声（noteDrop 立即报）；session_shutdown 汇总（flush 完再报账）
	await h2["session_shutdown"][0]();
	return true;
}, {
	"/telemetry/ingest": { status: 503, body: { error: "archive down" } },
});
console.log("loud drop with shell present (503, no throw):", r6 === true);

// 7) 洞1另一半：拆卸态（壳不在场）flush 静默——不 warn 不计数不炸
//    （collaborator A #738 钉子：结果并进 checks，静默合法也受门禁管）
let silentOk = false;
{
	let warned = false;
	const origWarn = console.warn;
	console.warn = (...a) => { warned = true; origWarn(...a); };
	try {
		for (const h of hooks["tool_execution_end"]) await h({ toolCallId: "t2", toolName: "bash", isError: false });
		await hooks["agent_settled"][0]();
		await hooks["session_shutdown"][0]();
	} finally {
		console.warn = origWarn;
	}
	silentOk = warned === false;
	console.log("silent drop in dismantled state (no warn):", silentOk);
}

const checks = [r1?.block === true, r2 === undefined, r3 === undefined, r3b?.messages?.[0]?.role === "user" && String(r3b?.messages?.[0]?.content).includes("技能经图（Grimoire）"), entries[0]?.data.agent === "pianist-dev-1", out.details.wired === false, r6 === true, silentOk];
console.log("PASS " + checks.filter(Boolean).length + "/" + checks.length);
// 门禁硬墙：红必须挡门（此前只 print 不 exit，全红也 exit 0，npm test 的 && 链拦不住）
process.exit(checks.every(Boolean) ? 0 : 1);
