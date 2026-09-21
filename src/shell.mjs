/**
 * pianist-shell — 壳骨架 v0（施工②第一块积木，2026-09-20）
 *
 * 三层架构里的壳层，但只长出施工②逼出来的那一块骨头：
 *   1. /tools/invoke 统一入口 —— pianist extension 的 pianist_bridge 打这里
 *   2. grimoire 提供者 —— 代理Grimoire（纯 HTTP server，转发即可）
 *   3. spoor 提供者 —— MCP streamable-HTTP 客户端（壳持有连接，一实例一署名）
 *
 * 刻意不做：多 slot / cron / 通信层 / 审批队列 —— 继续缓建。
 * 铁律继承：壳永不直接调 LLM API（本骨架无任何 LLM 依赖，天然合规）。
 *
 * 架构依据：pianist-runtime-dependency-map v3（spoor 档案房）
 *          + Grimoire origin/main README 协议面（2026-09-20 fetch，未替上游猜接口）
 *
 * 启动：PIANIST_SHELL_PORT=8770 node src/shell.mjs
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PIANIST_SHELL_PORT ?? 8770);
const GRIMOIRE_URL = process.env.GRIMOIRE_URL ?? "http://127.0.0.1:8730";
// spoor 三 server 一住户一实例（8791/8792 留给其他实例，pianist 从 8793 起）
const SPOOR_WORKBENCH_URL = process.env.SPOOR_WORKBENCH_URL ?? "http://127.0.0.1:8793/mcp";
const SPOOR_ARCHIVE_URL = process.env.SPOOR_ARCHIVE_URL ?? "http://127.0.0.1:8794/mcp";
const SPOOR_SCRATCHPAD_URL = process.env.SPOOR_SCRATCHPAD_URL ?? "http://127.0.0.1:8795/mcp";

// 转发超时（本机服务正常毫秒级；留余量给冷启动）
const FORWARD_TIMEOUT_MS = 15_000;

// 遥测存档（施工③接口面）：JSONL 追加，按 agent 分文件，按天轮转。
// 目录可配（PIANIST_TELEMETRY_DIR），默认 pianist-runtime/data/telemetry/
const TELEMETRY_DIR = process.env.PIANIST_TELEMETRY_DIR ?? path.resolve("data/telemetry");

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

let nextRpcId = 1;

function safeJsonParse(text) {
	try { return JSON.parse(text); } catch { return undefined; }
}

async function timedFetch(url, init, label) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), FORWARD_TIMEOUT_MS);
	try {
		const res = await fetch(url, { ...init, signal: ctrl.signal });
		const text = await res.text();
		return { status: res.status, headers: res.headers, text };
	} catch (err) {
		throw new Error(`shell: ${label} 请求失败（${String(err?.cause ?? err?.message ?? err)}）`);
	} finally {
		clearTimeout(timer);
	}
}

/** streamable HTTP MCP 响应可能是纯 JSON，也可能是 SSE 流——两种都解 */
function parseMcpResponse(text, tool) {
	const direct = safeJsonParse(text);
	if (direct !== undefined) {
		if (direct.error) return { error: String(direct.error.message ?? direct.error) };
		if (direct.result?.content) return direct.result;
		return direct.result ?? direct;
	}
	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const obj = safeJsonParse(line.slice(5).trim());
		if (obj === undefined) continue;
		if (obj.error) return { error: String(obj.error.message ?? obj.error) };
		const r = obj.result ?? obj;
		if (r && typeof r === "object" && ("content" in r || "error" in r)) return r;
	}
	return { error: `shell: 无法解析 spoor 响应（${tool}）` };
}

// ---------------------------------------------------------------------------
// 提供者：grimoire（Grimoire）—— 纯 HTTP 代理
// ---------------------------------------------------------------------------

/** Grimoire读面+写面全量转发（GET/POST）。写面 POST 补 operator 缺省（Grimoire按 operator 记账） */
async function grimoireForward(path, method, body, agentId) {
	const url = new URL(path, GRIMOIRE_URL);
	let outBody = body;
	if (method === "POST" && body) {
		const parsed = safeJsonParse(body);
		if (parsed && typeof parsed === "object" && !parsed.operator) {
			parsed.operator = agentId || "pianist-pianist";
		}
		outBody = JSON.stringify(parsed);
	}
	const init = { method };
	if (outBody != null) {
		init.headers = { "content-type": "application/json" };
		init.body = outBody;
	}
	return timedFetch(url, init, "grimoire");
}

// ---------------------------------------------------------------------------
// 提供者：spoor —— MCP streamable-HTTP 客户端（壳持有连接）
// ---------------------------------------------------------------------------

/**
 * 会话管理（2026-09-20 探针实证：FastMCP 1.29 streamable-HTTP 是有状态会话）：
 *   - 裸 tools/call 不带 session → 400 "Missing session ID"
 *   - initialize 响应头给 mcp-session-id，后续每发必须带
 *   - 会话过期表现为 400/404 带 session 字样 → 重握手一次再试（每 URL 独立会话）
 */
const mcpSessions = new Map(); // url → session id

async function mcpInitialize(url) {
	const { status, headers, text } = await timedFetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: nextRpcId++,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "pianist-shell", version: "0.0.1" },
			},
		}),
	}, "spoor-init");
	if (status !== 200) throw new Error(`spoor: initialize HTTP ${status}（${text.slice(0, 200)}）`);
	const sid = headers.get("mcp-session-id");
	if (!sid) throw new Error("spoor: initialize 响应缺 mcp-session-id 头");
	// 初始化通知（协议要求，fire-and-forget）
	await timedFetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"mcp-session-id": sid,
		},
		body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
	}, "spoor-initialized");
	return sid;
}

/** tools/call over streamable HTTP。会话过期自动重握手一次 */
async function mcpCall(url, tool, args) {
	let sid = mcpSessions.get(url);
	if (!sid) {
		sid = await mcpInitialize(url);
		mcpSessions.set(url, sid);
	}
	for (let attempt = 0; attempt < 2; attempt++) {
		const { status, text } = await timedFetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
				"mcp-session-id": sid,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: nextRpcId++,
				method: "tools/call",
				params: { name: tool, arguments: args ?? {} },
			}),
		}, "spoor");
		if (status === 200) return parseMcpResponse(text, tool);
		if ((status === 400 || status === 404) && /session/i.test(text)) {
			// 会话过期/丢失 → 重握手再试一轮
			sid = await mcpInitialize(url);
			mcpSessions.set(url, sid);
			continue;
		}
		if (status === 404) {
			return { error: `spoor: 工具不存在（HTTP 404，${tool}）——核对工具名` };
		}
		return { error: `spoor: HTTP ${status}（${text.slice(0, 200)}）` };
	}
	return { error: `spoor: 会话重握手后仍失败（${tool}）` };
}

// ---------------------------------------------------------------------------
// 工具目录（pianist可见的名字 → 提供者路由）
// ---------------------------------------------------------------------------

/** pianist侧工具名 → 提供者（Grimoire直接代理；spoor 按三 server 分域） */
const TOOL_ROUTES = {
	// Grimoire（读面映射成工具名；写面 POST /skill、POST /event）
	grimoire_map: { kind: "grimoire", path: "/map" },
	grimoire_tag: { kind: "grimoire", path: "/tag/{tag}" },
	grimoire_skill: { kind: "grimoire", path: "/skill/{id}" },
	grimoire_darkzone: { kind: "grimoire", path: "/darkzone" },
	grimoire_stats: { kind: "grimoire", path: "/stats" },
	grimoire_submit: { kind: "grimoire", path: "/skill", method: "POST" },
	grimoire_event: { kind: "grimoire", path: "/event", method: "POST" },

	// spoor 工作台（workbench，8793）
	spoor_list: { kind: "spoor", url: SPOOR_WORKBENCH_URL, tool: "workbench_list" },
	spoor_search: { kind: "spoor", url: SPOOR_WORKBENCH_URL, tool: "workbench_search" },
	spoor_journal: { kind: "spoor", url: SPOOR_WORKBENCH_URL, tool: "workbench_journal" },
	spoor_read_journal: { kind: "spoor", url: SPOOR_WORKBENCH_URL, tool: "workbench_read_journal" },
	spoor_status: { kind: "spoor", url: SPOOR_WORKBENCH_URL, tool: "workbench_status" },
	spoor_snippet: { kind: "spoor", url: SPOOR_WORKBENCH_URL, tool: "workbench_snippet" },

	// spoor 档案房（archive，8794）
	spoor_archive_get: { kind: "spoor", url: SPOOR_ARCHIVE_URL, tool: "archive_get" },
	spoor_archive_list: { kind: "spoor", url: SPOOR_ARCHIVE_URL, tool: "archive_list" },
	spoor_archive_put: { kind: "spoor", url: SPOOR_ARCHIVE_URL, tool: "archive_put" },
	spoor_archive_query: { kind: "spoor", url: SPOOR_ARCHIVE_URL, tool: "archive_query" },

	// spoor 涂鸦房（scratchpad，8795）
	spoor_scratch_create: { kind: "spoor", url: SPOOR_SCRATCHPAD_URL, tool: "scratchpad_create" },
	spoor_scratch_write: { kind: "spoor", url: SPOOR_SCRATCHPAD_URL, tool: "scratchpad_write" },
	spoor_scratch_read: { kind: "spoor", url: SPOOR_SCRATCHPAD_URL, tool: "scratchpad_read" },
};

/** 路径参数展开：grimoire_tag 需要 {tag}、grimoire_skill 需要 {id}（或 name） */
function expandRoute(route, args) {
	let path = route.path;
	if (route.path?.includes("{tag}") && args?.tag) path = path.replace("{tag}", encodeURIComponent(args.tag));
	if (route.path?.includes("{id}") && (args?.id || args?.name)) {
		path = path.replace("{id}", encodeURIComponent(String(args?.id ?? args?.name)));
	}
	return path;
}

// ---------------------------------------------------------------------------
// 遥测存档（施工③接口面：主干→自学习的单向通道终点）
// ---------------------------------------------------------------------------

/** 落盘一行。同步追加（量小、本地盘、批次到达时写一次——可接受；异步回调丢事件不可接受） */
function telemetryAppend(events) {
	if (!Array.isArray(events) || events.length === 0) return 0;
	const byAgent = new Map();
	for (const ev of events) {
		const agent = typeof ev?.agent === "string" && ev.agent ? ev.agent : "unknown";
		(byAgent.get(agent) ?? byAgent.set(agent, []).get(agent)).push(ev);
	}
	let written = 0;
	for (const [agent, evs] of byAgent) {
		const day = new Date().toISOString().slice(0, 10);
		const file = path.join(TELEMETRY_DIR, `${agent}-${day}.jsonl`);
		const lines = evs
			.filter((ev) => ev && typeof ev === "object" && typeof ev.kind === "string")
			.filter((ev) => {
				const size = JSON.stringify(ev).length;
				if (size > 32_768) {
					console.warn(`telemetry: 事件过大丢弃（${agent} ${ev.kind} ${size}B > 32KB 上限）`);
					return false;
				}
				return true;
			})
			.map((ev) => JSON.stringify({ v: 1, ...ev }));
		if (lines.length === 0) continue;
		fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
		fs.appendFileSync(file, lines.join("\n") + "\n");
		written += lines.length;
	}
	return written;
}

// ---------------------------------------------------------------------------
// /tools/invoke 统一入口
// ---------------------------------------------------------------------------

async function invokeTool(action, args, agentId) {
	const route = TOOL_ROUTES[action];
	if (!route) {
		return { error: `未知工具 action=${action}。可用：${Object.keys(TOOL_ROUTES).join(", ")}` };
	}
	if (route.kind === "grimoire") {
		const method = route.method ?? "GET";
		const path = expandRoute(route, args);
		const body = method === "POST" ? JSON.stringify(args ?? {}) : undefined;
		const { status, text } = await grimoireForward(path, method, body, agentId);
		return { status, body: safeJsonParse(text) ?? text };
	}
	if (route.kind === "spoor") {
		return mcpCall(route.url, route.tool, args);
	}
	return { error: `内部错误：未知提供者类型 ${route.kind}` };
}

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
	const u = new URL(req.url, `http://127.0.0.1:${PORT}`);
	if (u.pathname === "/health") {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({
			ok: true,
			version: "pianist-shell v0.0.1 (施工②)",
			grimoire: GRIMOIRE_URL,
			spoor: { workbench: SPOOR_WORKBENCH_URL, archive: SPOOR_ARCHIVE_URL, scratchpad: SPOOR_SCRATCHPAD_URL },
			tools: Object.keys(TOOL_ROUTES).length,
		}));
		return;
	}
	if (req.method === "POST" && u.pathname === "/tools/invoke") {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = Buffer.concat(chunks).toString("utf8");
		const parsed = safeJsonParse(body);
		if (!parsed || typeof parsed.action !== "string") {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "body 需为 { action, payload?, agent? }" }));
			return;
		}
		try {
			const out = await invokeTool(parsed.action, parsed.payload ?? parsed.args, parsed.agent);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(out));
		} catch (err) {
			res.writeHead(502, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: String(err?.message ?? err) }));
		}
		return;
	}
	if (req.method === "POST" && u.pathname === "/telemetry/ingest") {
		const chunks = [];
		for await (const c of req) chunks.push(c);
		const body = Buffer.concat(chunks).toString("utf8");
		const parsed = safeJsonParse(body);
		const events = Array.isArray(parsed?.events) ? parsed.events : null;
		if (!events) {
			res.writeHead(400, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: "body 需为 { agent, events: [...] }" }));
			return;
		}
		try {
			const written = telemetryAppend(events);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ ok: true, written }));
		} catch (err) {
			// 存档失败不背锅给pianist——遥测是旁挂，503 让扩展侧静默丢弃
			res.writeHead(503, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: String(err?.message ?? err) }));
		}
		return;
	}
	res.writeHead(404, { "content-type": "application/json" });
	res.end(JSON.stringify({ error: `not found: ${req.method} ${u.pathname}` }));
});

server.listen(PORT, "127.0.0.1", () => {
	console.log(`pianist-shell v0 listening on 127.0.0.1:${PORT}`);
	console.log(`  grimoire → ${GRIMOIRE_URL}`);
	console.log(`  spoor workbench → ${SPOOR_WORKBENCH_URL}`);
	console.log(`  spoor archive → ${SPOOR_ARCHIVE_URL}`);
	console.log(`  spoor scratchpad → ${SPOOR_SCRATCHPAD_URL}`);
});
