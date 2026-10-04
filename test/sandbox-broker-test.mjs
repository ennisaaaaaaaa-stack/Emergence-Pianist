// T15 活二测试：沙箱×钥匙柜接缝——沙箱内 agent 隔墙喊 broker（vault.internal 内部端点）
// 验证链：
//   单元级（brokerCore 直调，mock 起 127.0.0.1 + allowPrivate:true 测试参数）：
//     1) 成功路径：mock 收到含值 header（比对出布尔）、输出零值、tmp 夹具记账零值
//     2) 反探洞默认拒：不传 allowPrivate 时裸 IP / 解析到环回的域名均 403+出声（exit 3）
//     3) 无 env 后门：设了 PORTALK_SANDBOX_BROKER_ALLOW_PRIVATE=1 也不影响 brokerCore 默认拒
//     4) 授权拒（无配置钥匙）/ 柜无此钥匙 / 形状坏：各自人话错误 + 状态码
//   集成级（真沙箱回合，学 sandbox.test.mjs 的 sandbox() helper）：
//     5) 沙箱内 curl POST http://vault.internal/use：gate 识别保留域不出网，转墙外 brokerCore，
//        沙箱 stdout 只有响应 body 不含值；cred-journal 落 use-sandbox-broker（agent=沙箱工牌）
//     6) 错误语义穿透接缝：柜无此钥匙 403 / 坏 JSON 400 / 未知路径 404
//     7) 不设逃生门 env 的回合：内网目标被 brokerCore 拒且出声（默认安全）
//     8) 回归：沙箱内 curl 真内网地址仍被原门禁 403（接缝没松原有的门）
// 纪律：任何 check 名与输出不含夹具值本体（断言只出布尔/长度/状态码）。
// 运行：node test/sandbox-broker-test.mjs（需 root + Landlock；已挂进 npm test）

import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pianist-sbx-broker-"));
process.env.PORTALK_CRED_DIR = path.join(tmpDir, "cred");
process.env.PORTALK_CRED_JOURNAL = path.join(tmpDir, "journal.jsonl");
process.env.PORTALK_CRED_TIERS = path.join(tmpDir, "tiers.json");

const store = await import("../credentials/store.mjs");
const { brokerCore } = await import("../credentials/broker.mjs");
const { journalPath } = await import("../credentials/journal.mjs");

let pass = 0,
	total = 0;
function check(name, ok) {
	total++;
	if (ok) pass++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

// 夹具值只存在于本文件与 tmp 夹具目录，永不上输出
const V_SBX = "sbx-broker-secret-4f8a1d2e3c";
fs.writeFileSync(
	process.env.PORTALK_CRED_TIERS,
	JSON.stringify({ standing: ["sbx-key", "ghost-key"], task: [], "per-use": [] }),
);
store.write("sbx-key", V_SBX); // ghost-key 在 tiers 不在柜：专测「柜无此钥匙」错误路径

const credJournalText = () => fs.readFileSync(process.env.PORTALK_CRED_JOURNAL, "utf8");

/** 起 mock 目标（root 侧，127.0.0.1）：只回显值长度不回值（学 credentials.test.mjs §6 纪律） */
function startMock() {
	let lastReq = null;
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			lastReq = { method: req.method, url: req.url, authorization: req.headers.authorization ?? null, body };
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ ok: true, authLen: (req.headers.authorization ?? "").length, bodyLen: body.length }));
		});
	});
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, lastReq: () => lastReq })));
}

// ---------------------------------------------------------------------------
// 1) 单元级：brokerCore 直调（allowPrivate:true = 测试逃生门，options 参数）
// ---------------------------------------------------------------------------
{
	const mock = await startMock();
	const r = await brokerCore({
		name: "sbx-key",
		url: `http://127.0.0.1:${mock.port}/echo`,
		method: "POST",
		headers: ["Authorization: Bearer {VALUE}"],
		body: '{"ping":1}',
		allowPrivate: true,
	});
	const got = mock.lastReq();
	check("brokerCore: ok 且只回响应 body", r.ok === true && typeof r.body === "string");
	check("brokerCore: mock 收到含值 header（精确比对出布尔）", got.authorization === `Bearer ${V_SBX}`);
	check("brokerCore: mock 收到 method/url/body", got.method === "POST" && got.url === "/echo" && got.body === '{"ping":1}');
	check("brokerCore: 输出是 mock 的 JSON（authLen 对）", JSON.parse(r.body).ok === true && JSON.parse(r.body).authLen === `Bearer ${V_SBX}`.length);
	check("brokerCore: 输出零值", !r.body.includes(V_SBX));
	check("brokerCore: 记账零值", !credJournalText().includes(V_SBX));
	mock.server.close();
}

// ---------------------------------------------------------------------------
// 2) 反探洞默认拒（命门）：不传 allowPrivate 时裸 IP / 内网域名均拒且出声
// ---------------------------------------------------------------------------
{
	const bare = await brokerCore({ name: "sbx-key", url: "http://127.0.0.1:9/x", headers: ["Authorization: Bearer {VALUE}"] });
	check(
		`brokerCore: 裸 IP 127.0.0.1 默认拒（status=${bare.status} exit=${bare.exitCode}）`,
		bare.ok === false && bare.status === 403 && bare.exitCode === 3 && bare.error.includes("拒"),
	);
	const rfc1918 = await brokerCore({ name: "sbx-key", url: "http://192.168.1.1/x", headers: ["Authorization: Bearer {VALUE}"] });
	check(`brokerCore: RFC1918 裸 IP 默认拒（status=${rfc1918.status}）`, rfc1918.ok === false && rfc1918.status === 403);
	const viaDns = await brokerCore({ name: "sbx-key", url: "http://localhost:9/x", headers: ["Authorization: Bearer {VALUE}"] });
	check(
		`brokerCore: 域名解析到环回也拒（DNS 复核路径，status=${viaDns.status}）`,
		viaDns.ok === false && viaDns.status === 403 && viaDns.exitCode === 3,
	);
	// env 无后门：brokerCore 只认显式 allowPrivate 参数（env 逃生门是 gate 侧测试开关，不进核）
	process.env.PORTALK_SANDBOX_BROKER_ALLOW_PRIVATE = "1";
	const envNo = await brokerCore({ name: "sbx-key", url: "http://127.0.0.1:9/x", headers: ["Authorization: Bearer {VALUE}"] });
	check("brokerCore: 设了逃生门 env 也不放行内网（核层无 env 后门）", envNo.ok === false && envNo.status === 403);
	delete process.env.PORTALK_SANDBOX_BROKER_ALLOW_PRIVATE;
}

// ---------------------------------------------------------------------------
// 3) 错误语义：授权拒 / 柜无此钥匙 / 形状坏
// ---------------------------------------------------------------------------
{
	const denied = await brokerCore({ name: "never-configured", url: "http://example.com/x", headers: ["Authorization: Bearer {VALUE}"], allowPrivate: true });
	check(
		`brokerCore: 无配置钥匙授权拒（status=${denied.status} exit=${denied.exitCode}）`,
		denied.ok === false && denied.status === 403 && denied.exitCode === 3 && denied.error.includes("拒绝"),
	);
	const ghost = await brokerCore({ name: "ghost-key", url: "http://example.com/x", headers: ["Authorization: Bearer {VALUE}"], allowPrivate: true });
	check(
		`brokerCore: 柜无此钥匙人话错误（status=${ghost.status}）`,
		ghost.ok === false && ghost.status === 403 && ghost.error.includes("钥匙柜"),
	);
	const shape = await brokerCore({ url: "http://example.com/x", allowPrivate: true });
	check(`brokerCore: 缺 name 形状坏（status=${shape.status}）`, shape.ok === false && shape.status === 400);
	const proto = await brokerCore({ name: "sbx-key", url: "ftp://example.com/x", headers: [], allowPrivate: true });
	check(`brokerCore: 非 http/https 协议拒（status=${proto.status}）`, proto.ok === false && proto.status === 400);
}

// ---------------------------------------------------------------------------
// 4) 集成级前置：定制策略（identity.agent=沙箱工牌，非 pianist 默认值）+ root 侧 mock 目标
// ---------------------------------------------------------------------------
const AGENT_BADGE = "sbx-e2e-agent";
const POLICY = path.join(tmpDir, "policy.json");
{
	const p = JSON.parse(fs.readFileSync(path.join(repoRoot, "sandbox/policies/default.policy.json"), "utf8"));
	p.identity.agent = AGENT_BADGE;
	fs.writeFileSync(POLICY, JSON.stringify(p));
}
const SANDBOX_JOURNAL = path.join(repoRoot, "data", "sandbox-journal.jsonl");

/** 起一个沙箱回合（黑盒走 CLI 契约；escapeEnv 仅测试回合置逃生门） */
function sandbox(cmd, { timeoutMs = 60_000, escapeEnv = {} } = {}) {
	return new Promise((resolve) => {
		const child = spawn(
			"node",
			["sandbox/run-sandboxed.mjs", "--policy", POLICY, "--timeout-ms", String(timeoutMs), "--", ...cmd],
			{ cwd: repoRoot, env: { ...process.env, ...escapeEnv } },
		);
		let out = "";
		let err = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (err += c));
		child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
		child.on("error", (e) => resolve({ code: -1, stdout: out, stderr: String(e) }));
	});
}

/** 沙箱内 curl 打 vault.internal/use；-w 尾行回 HTTP 状态码方便断言语义 */
const vaultCurl = (payload) => [
	"curl", "-sS", "--max-time", "30", "-X", "POST", "http://vault.internal/use",
	"-H", "content-type: application/json", "--data-binary", JSON.stringify(payload), "-w", "\n%{http_code}",
];
const splitCurlOut = (out) => {
	const m = out.trimEnd().match(/\n(\d{3})$/);
	return m ? { body: out.slice(0, m.index), code: m[1] } : { body: out, code: "?" };
};

// ---------------------------------------------------------------------------
// 5) 集成级正路：沙箱内隔墙喊钥匙——值零回流（stdout/两本账/.stderr 三面）
// ---------------------------------------------------------------------------
{
	const mock = await startMock();
	const r = await sandbox(vaultCurl({ name: "sbx-key", url: `http://127.0.0.1:${mock.port}/echo`, method: "POST", header: "Authorization: Bearer {VALUE}" }), {
		escapeEnv: { PORTALK_SANDBOX_BROKER_ALLOW_PRIVATE: "1" }, // 集成级逃生门：仅测试置位（mock 起在环回）
	});
	const { body, code } = splitCurlOut(r.stdout);
	const parsed = (() => { try { return JSON.parse(body); } catch { return null; } })();
	check(
		`集成：沙箱内 curl vault.internal/use 通（HTTP ${code}，exit=${r.code}）`,
		r.code === 0 && code === "200",
	);
	check(
		`集成：沙箱 stdout 只有响应 body（mock 的 authLen=${parsed?.authLen ?? "?"} 对）`,
		parsed?.ok === true && parsed.authLen === `Bearer ${V_SBX}`.length,
	);
	check("集成：沙箱 stdout 零值", !r.stdout.includes(V_SBX) && !r.stderr.includes(V_SBX));

	const lines = credJournalText().trim().split("\n").map((l) => JSON.parse(l));
	const rec = lines.filter((l) => l.action === "use-sandbox-broker" && l.name === "sbx-key").pop();
	check(
		`集成：cred-journal 落 use-sandbox-broker（agent=${rec?.agent ?? "?"} host=${rec?.host ?? "?"} tier=${rec?.tier ?? "?"}）`,
		Boolean(rec) && rec.agent === AGENT_BADGE && rec.host === `127.0.0.1:${mock.port}` && rec.tier === "standing",
	);
	check("集成：记账工牌是沙箱工牌（不是 pianist 默认值）", Boolean(rec) && rec.agent === AGENT_BADGE && rec.agent !== "pianist");
	check("集成：cred-journal 整本零值", !credJournalText().includes(V_SBX));
	check("集成：sandbox-journal（门禁账）整本零值", !fs.readFileSync(SANDBOX_JOURNAL, "utf8").includes(V_SBX));
	mock.server.close();
}

// ---------------------------------------------------------------------------
// 6) 错误语义穿透接缝：柜无此钥匙 403 / 坏 JSON 400 / 未知路径 404
// ---------------------------------------------------------------------------
{
	const mock = await startMock();
	const ghost = await sandbox(vaultCurl({ name: "ghost-key", url: `http://127.0.0.1:${mock.port}/echo`, header: "Authorization: Bearer {VALUE}" }), {
		escapeEnv: { PORTALK_SANDBOX_BROKER_ALLOW_PRIVATE: "1" },
	});
	const g = splitCurlOut(ghost.stdout);
	check(
		`集成：柜无此钥匙 → 403 人话（HTTP ${g.code}）`,
		ghost.code === 0 && g.code === "403" && g.body.includes("钥匙柜") && !g.body.includes(V_SBX),
	);

	const badJson = await sandbox([
		"curl", "-sS", "--max-time", "30", "-X", "POST", "http://vault.internal/use",
		"-H", "content-type: application/json", "--data-binary", "not-json", "-w", "\n%{http_code}",
	], { escapeEnv: { PORTALK_SANDBOX_BROKER_ALLOW_PRIVATE: "1" } });
	const b = splitCurlOut(badJson.stdout);
	check(`集成：坏 JSON → 400（HTTP ${b.code}）`, badJson.code === 0 && b.code === "400" && b.body.includes("JSON"));

	const notFound = await sandbox([
		"curl", "-sS", "--max-time", "30", "-X", "POST", "http://vault.internal/other",
		"--data-binary", "{}", "-w", "\n%{http_code}",
	], { escapeEnv: { PORTALK_SANDBOX_BROKER_ALLOW_PRIVATE: "1" } });
	const n = splitCurlOut(notFound.stdout);
	check(`集成：未知路径 → 404（HTTP ${n.code}）`, notFound.code === 0 && n.code === "404");
	mock.server.close();
}

// ---------------------------------------------------------------------------
// 7) 不设逃生门 env 的回合：沙箱内喊内网目标被 brokerCore 拒且出声（默认安全）
// ---------------------------------------------------------------------------
{
	const probe = await sandbox(vaultCurl({ name: "sbx-key", url: "http://localhost:9/x", header: "Authorization: Bearer {VALUE}" }));
	const p = splitCurlOut(probe.stdout);
	check(
		`集成：不设逃生门时内网目标被拒（HTTP ${p.code}，文本出声）`,
		probe.code === 0 && p.code === "403" && p.body.includes("拒") && !p.body.includes(V_SBX),
	);
}

// ---------------------------------------------------------------------------
// 8) 回归：接缝没松原有的门——沙箱内直接 curl 真内网地址仍被原门禁 403
// ---------------------------------------------------------------------------
{
	const r = await sandbox(["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", "http://10.255.255.1/"]);
	check(`回归：经代理裸 IP 10.255.255.1 仍被门禁 403 硬拒 — ${r.stdout.trim()}`, r.code === 0 && r.stdout.trim() === "403");
}

// ---------------------------------------------------------------------------
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`${pass}/${total} passed`);
if (pass !== total) process.exit(1);
