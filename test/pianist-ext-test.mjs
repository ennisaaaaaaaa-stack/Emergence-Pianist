// pianist-tools 加载测试：mock ExtensionAPI，验证三件套钩子+桥工具注册
import http from "node:http";
import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

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

const checks = [r1?.block === true, r2 === undefined, r3 === undefined, r3b?.messages?.[0]?.role === "user" && String(r3b?.messages?.[0]?.content).includes("技能经图（Grimoire）"), entries[0]?.data.agent === "pianist-dev-1", out.details.wired === false];
console.log("PASS " + checks.filter(Boolean).length + "/6");
