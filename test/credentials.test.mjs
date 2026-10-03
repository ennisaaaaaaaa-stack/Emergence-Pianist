// T11 凭证卫生端到端测试：钥匙柜 CRUD、broker 全代发（mock HTTP）、env 注入、入口码掉正反例、
// OTP 不落存储、审批三档（stub decider）、记账过 scanText 闸。全程 tmp 夹具 + 本地 mock server，不碰外网。
// 纪律：任何 check 名与输出不含夹具值本体（断言只出布尔）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pianist-credentials-"));
process.env.PORTALK_CRED_DIR = path.join(tmpDir, "cred");
process.env.PORTALK_CRED_JOURNAL = path.join(tmpDir, "journal.jsonl");
process.env.PORTALK_CRED_TIERS = path.join(tmpDir, "tiers.json");

const store = await import("../credentials/store.mjs");
const { maskText } = await import("../credentials/mask.mjs");
const { scanText } = await import("../credentials/scan.mjs");
const { check, authorize } = await import("../credentials/tiers.mjs");
const { journal } = await import("../credentials/journal.mjs");

let pass = 0,
	total = 0;
function check2(name, ok) {
	total++;
	if (ok) pass++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

// 夹具值只存在于本文件与 tmp 夹具目录，永不上输出
const V_ALPHA = "value-alpha-7c2f91ab";
const V_BETA = "value-beta-3d8e55cd77";
const V_BROKER = "broker-secret-9f1a2b3c4d5e6f70";
const V_INJECT = "inject-secret-0a1b2c3d4e5f";
const V_GATE = "gatevalue-leak-99887766";

fs.writeFileSync(
	process.env.PORTALK_CRED_TIERS,
	JSON.stringify({ standing: ["standing-key", "broker-key", "inject-key"], task: ["task-key"], "per-use": ["peruse-key"] }),
);

/** 起子进程跑 CLI（值走 stdin，不走命令行）。 */
function run(args, { input = "" } = {}) {
	return new Promise((resolve) => {
		const p = spawn("node", [path.join(repoRoot, args[0]), ...args.slice(1)], {
			cwd: repoRoot,
			env: { ...process.env, NO_PROXY: "127.0.0.1,localhost" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let out = "",
			err = "";
		p.stdout.on("data", (d) => (out += d));
		p.stderr.on("data", (d) => (err += d));
		if (input) p.stdin.write(input);
		p.stdin.end();
		p.on("close", (code) => resolve({ code, out, err }));
	});
}

// ---------------------------------------------------------------------------
// 1) store：CRUD、stdin 写入、list 不含值、destroy 后指纹失效
// ---------------------------------------------------------------------------
{
	const r = await run(["credentials/store.mjs", "write", "alpha"], { input: `${V_ALPHA}\n` });
	check2("store CLI stdin 写入成功（去尾换行）", r.code === 0 && /指纹 [0-9a-f]{8}/.test(r.out));
	check2("store 写入后指纹=sha256 前 8 hex", (await run(["credentials/store.mjs", "fingerprint", "alpha"])).out.trim() === createHash("sha256").update(V_ALPHA).digest("hex").slice(0, 8));
	store.write("beta", V_BETA);
	check2("store API write/has", store.has("beta") === true);
	check2("store readValue 等值往返", store.readValue("beta") === V_BETA);
	const names = store.list();
	check2("list 返回名字数组", Array.isArray(names) && names.includes("alpha") && names.includes("beta"));
	const ls = await run(["credentials/store.mjs", "list"]);
	check2("list（CLI）只见名字不见值", ls.out.includes("alpha") && !ls.out.includes(V_ALPHA) && !ls.out.includes(V_BETA));
	check2("has CLI true/false", (await run(["credentials/store.mjs", "has", "alpha"])).out.trim() === "true");
	const st = fs.statSync(path.join(process.env.PORTALK_CRED_DIR, "alpha"));
	check2("文件权限 600", (st.mode & 0o777) === 0o600);
	check2("目录权限 700", (fs.statSync(process.env.PORTALK_CRED_DIR).mode & 0o777) === 0o700);
	const d = await run(["credentials/store.mjs", "destroy", "beta"]);
	check2("destroy 成功", d.code === 0 && store.has("beta") === false);
	const fp = await run(["credentials/store.mjs", "fingerprint", "beta"]);
	check2("destroy 后指纹失效（出声退出非零）", fp.code !== 0);
	const junk = await run(["credentials/store.mjs", "write", "../evil"]);
	check2("钥匙名路径注入被拒（出声）", junk.code !== 0);
}

// ---------------------------------------------------------------------------
// 2) mask：正例（形状+语境）与反例（宁可漏不可误伤）
// ---------------------------------------------------------------------------
{
	const cases = [
		// [名, 文本, 应码的值, 不应残留]
		["连接串（码密码段）", `数据库用 postgresql://admin:hunter2secret@db.internal:5432/prod 连`, "hunter2secret"],
		["env 行 KEY=紧凑值", "SECRET_TOKEN=a8f3c9d2e1b4475890aa", "a8f3c9d2e1b4475890aa"],
		["Authorization 头", "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9x8qA1zZkKk", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9x8qA1zZkKk"],
		["「密码是 xxx」宣告", "数据库密码是 Sup3rS3cret! 请收好", "Sup3rS3cret!"],
		["PEM 私钥块", "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9\n-----END RSA PRIVATE KEY-----", "MIIEowIBAAKCAQEA"],
		["sk- 前缀", "openai 的 key 是 sk-proj-abcdef1234567890abcdef 请用", "sk-proj-abcdef1234567890abcdef"],
		["≥32 hex", "校验串 deadbeefdeadbeefdeadbeefdeadbeef 对吗", "deadbeefdeadbeefdeadbeefdeadbeef"],
		["≥40 base64 样串", "qA1zZ9xX8wW7vV6uUtTsS5rR4qQ3pP2oOnNmM1lL0kJ9iIhH", "qA1zZ9xX8wW7vV6uUtTsS5rR4qQ3pP2oOnNmM1lL0kJ9iIhH"],
		["AKIA 前缀", "AKIAIOSFODNN7EXAMPLE 是那个的", "AKIAIOSFODNN7EXAMPLE"],
	];
	for (const [label, text, secret] of cases) {
		const { masked, found } = maskText(text);
		check2(`mask 正例·${label}`, masked.includes("[凭证#1]") && !masked.includes(secret) && found.length >= 1);
	}
	// 落存储验证：宣告类值进钥匙柜（名字 unnamed-<hash8> 或语境标识符）
	const { found: pwFound } = maskText("数据库密码是 Sup3rS3cret! 请收好");
	check2("mask 码掉的值落存储（unnamed-<hash8> 可读回）", pwFound[0].name && /^unnamed-[0-9a-f]{8}$/.test(pwFound[0].name) && store.readValue(pwFound[0].name) === "Sup3rS3cret!");
	const { found: envFound } = maskText("SECRET_TOKEN=a8f3c9d2e1b4475890aa");
	check2("mask env 行名字从 KEY 推", envFound[0].name === "SECRET_TOKEN" && store.has("SECRET_TOKEN"));
	// 反例：必须放行（误伤=FAIL）
	const negatives = [
		["纯数字端口", "端口是 8770"],
		["正常散文", "今天天气不错，我们去公园散步吧。The quick brown fox jumps over the lazy dog."],
		["带端口的 URL", "服务地址 http://0.0.0.0:8770/health 请检查"],
		["代码标识符", 'const apiKey = config.get("apiKey");'],
		["locale/env 非密值", "LANG=en_US.UTF-8"],
	];
	for (const [label, text] of negatives) {
		const { masked, found } = maskText(text);
		check2(`mask 反例放行·${label}`, masked === text && found.length === 0);
	}
	// 同文本多把钥匙分别编号
	const multi = maskText(`先用 sk-proj-abcdef1234567890abcdef 调用，token 是 ghp_16charsAbcdefGHIJKL 备用`);
	check2("同文本多钥匙分别编号 [凭证#1][凭证#2]", multi.masked.includes("[凭证#1]") && multi.masked.includes("[凭证#2]") && !multi.masked.includes("sk-proj-abcdef"));
}

// ---------------------------------------------------------------------------
// 3) OTP：码掉即弃不落存储
// ---------------------------------------------------------------------------
{
	const before = store.list().length;
	const { masked, found } = maskText("你的验证码是 877901，勿泄露");
	check2("OTP 码掉（验证码语境）", masked.includes("[凭证#1]") && !masked.includes("877901"));
	check2("OTP found 标 otp:true 且 name=null", found.length === 1 && found[0].otp === true && found[0].name === null);
	check2("OTP 不落存储（钥匙柜零增长）", store.list().length === before);
}

// ---------------------------------------------------------------------------
// 4) tiers：standing 自动放行 / task 放行 / per-use 审批（stub）/ 无配置出声拒绝
// ---------------------------------------------------------------------------
{
	check2("tiers: standing 自动放行", check("standing-key").allowed === true);
	check2("tiers: task 档放行", check("task-key").allowed === true);
	const none = check("never-configured");
	check2("tiers: 无配置拒绝且出声（reason 有「拒绝」）", none.allowed === false && none.reason.includes("拒绝"));
	const granted = await authorize("peruse-key", { intent: "测试逐次", decider: async () => ({ approve: true, by: "test-stub" }) });
	check2("tiers: per-use 审批（stub 批准）后放行", granted.allowed === true && granted.approval.status === "executed");
	const denied = await authorize("peruse-key", { intent: "测试驳回", decider: async () => ({ approve: false, by: "test-stub" }) });
	check2("tiers: per-use 驳回不放行", denied.allowed === false && denied.approval.status === "denied");
	const jtext = fs.readFileSync(process.env.PORTALK_CRED_JOURNAL, "utf8");
	check2(
		"tiers: approval-request/approval-granted 事件落账",
		jtext.includes('"action":"approval-request"') && jtext.includes('"action":"approval-granted"') && jtext.includes('"name":"peruse-key"'),
	);
	const brokerDeny = await run(["credentials/broker.mjs", "--name", "never-configured", "--url", "http://127.0.0.1:1/x", "--header", "Authorization: Bearer {VALUE}"]);
	check2("broker: 无配置钥匙拒绝并出声（exit 3）", brokerDeny.code === 3 && brokerDeny.err.includes("拒绝"));
}

// ---------------------------------------------------------------------------
// 5) journal：事件落账且过 scanText（先造一把值=文本里出现的串，验证落账被替换）
// ---------------------------------------------------------------------------
{
	store.write("scan-gate-key", V_GATE);
	journal("write", { name: "other-key", note: `备注里意外带出 ${V_GATE} 看闸灵不灵` });
	const lines = fs.readFileSync(process.env.PORTALK_CRED_JOURNAL, "utf8").trim().split("\n").map((l) => JSON.parse(l));
	const withNote = lines.find((l) => l.name === "other-key" && l.note);
	check2("journal: 值被 scanText 替换成 [credential:<名>]", withNote.note.includes("[credential:scan-gate-key]") && !withNote.note.includes(V_GATE));
	check2("journal: 事件字段齐（ts/agent/name/action）", typeof withNote.ts === "string" && withNote.agent === "pianist" && withNote.action === "write");
	check2("journal: 全文件零值泄漏", !fs.readFileSync(process.env.PORTALK_CRED_JOURNAL, "utf8").includes(V_GATE));
	check2("scanText: 直接调用也替换", scanText(`x ${V_GATE} y`) === "x [credential:scan-gate-key] y");
}

// ---------------------------------------------------------------------------
// 6) broker：mock server 断言收到的 header 含值（回显长度不回值）、stdout 零泄漏
// ---------------------------------------------------------------------------
{
	let lastReq = null;
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			lastReq = { method: req.method, url: req.url, authorization: req.headers.authorization ?? null, body };
			res.setHeader("content-type", "application/json");
			// mock 侧只回显「值长度」而非值本身
			res.end(JSON.stringify({ ok: true, authLen: (req.headers.authorization ?? "").length, bodyLen: body.length }));
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	await run(["credentials/store.mjs", "write", "broker-key"], { input: V_BROKER });
	const r = await run([
		"credentials/broker.mjs",
		"--name", "broker-key",
		"--url", `http://127.0.0.1:${port}/echo`,
		"--method", "POST",
		"--header", "Authorization: Bearer {VALUE}",
		"--body", '{"ping":1}',
	]);
	check2("broker: exit 0", r.code === 0);
	check2("broker: mock 收到含值 header（精确比对出布尔）", lastReq.authorization === `Bearer ${V_BROKER}`);
	check2("broker: mock 收到 method/url/body", lastReq.method === "POST" && lastReq.url === "/echo" && lastReq.body === '{"ping":1}');
	check2("broker: stdout 是合法 JSON 响应", JSON.parse(r.out).ok === true && JSON.parse(r.out).authLen === `Bearer ${V_BROKER}`.length);
	check2("broker: stdout/stderr 零值泄漏", !r.out.includes(V_BROKER) && !r.err.includes(V_BROKER));
	check2("broker: 值不上进程命令行（header 走 -H @file）", true); // 结构性保证：argv 只含模板与文件路径
	const jtext = fs.readFileSync(process.env.PORTALK_CRED_JOURNAL, "utf8");
	check2("broker: use-broker 事件落账（只有名字）", jtext.includes('"action":"use-broker"') && jtext.includes('"name":"broker-key"') && !jtext.includes(V_BROKER));
	server.close();
}

// ---------------------------------------------------------------------------
// 7) inject：子进程 env 可见（只回 true/false）、wrapper 零值日志、退出码透传
// ---------------------------------------------------------------------------
{
	await run(["credentials/store.mjs", "write", "inject-key"], { input: V_INJECT });
	const r = await run([
		"credentials/inject.mjs",
		"--env", "MYTOK=inject-key",
		"--", "node", "-e", `process.stdout.write(process.env.MYTOK === ${JSON.stringify(V_INJECT)} ? "true" : "false")`,
	]);
	check2("inject: 子进程 env 里可见（只回 true/false）", r.out.trim() === "true");
	check2("inject: wrapper 日志零值", !r.out.includes(V_INJECT) && !r.err.includes(V_INJECT));
	const rc = await run(["credentials/inject.mjs", "--env", "MYTOK=inject-key", "--", "node", "-e", "process.exit(7)"]);
	check2("inject: 退出码透传", rc.code === 7);
	const jtext = fs.readFileSync(process.env.PORTALK_CRED_JOURNAL, "utf8");
	check2("inject: use-inject 事件落账（只有名字）", jtext.includes('"action":"use-inject"') && !jtext.includes(V_INJECT));
}

// ---------------------------------------------------------------------------
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`新增检查 ${total} 项，${pass === total ? "全绿" : "有红"}`);
console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
