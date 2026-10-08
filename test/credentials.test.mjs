// T11 凭证卫生端到端测试：钥匙柜 CRUD、broker 全代发（mock HTTP）、env 注入、入口码掉正反例、
// OTP 不落存储、审批三档（stub decider）、记账过 scanText 闸。全程 tmp 夹具 + 本地 mock server，不碰外网。
// T16（v2）：sidecar 来历（hui三问/status）、write 强制来历、墓碑闭环+同名复活、meta 补登、use 事件 context 落账；
// 阴性对照：v1 老钥匙（无 sidecar）来历缺失不炸、不带 context 的 use 事件无该字段。
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
const V_VAULT = "vault-value-6b7a8c9d0e1f";

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
	const r = await run(["credentials/store.mjs", "write", "alpha", "--owner", "test", "--purpose", "测试钥匙"], { input: `${V_ALPHA}\n` });
	check2("store CLI stdin 写入成功（去尾换行）", r.code === 0 && /指纹 [0-9a-f]{8}/.test(r.out));
	check2("store 写入后指纹=sha256 前 8 hex", (await run(["credentials/store.mjs", "fingerprint", "alpha"])).out.trim() === createHash("sha256").update(V_ALPHA).digest("hex").slice(0, 8));
	store.write("beta", V_BETA, { owner: "test", purpose: "测试钥匙" });
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
	const junk = await run(["credentials/store.mjs", "write", "../evil", "--owner", "t", "--purpose", "t"]);
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
	store.write("scan-gate-key", V_GATE, { owner: "test", purpose: "测试钥匙" });
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
	await run(["credentials/store.mjs", "write", "broker-key", "--owner", "test", "--purpose", "测试钥匙"], { input: V_BROKER });
	const r = await run([
		"credentials/broker.mjs",
		"--name", "broker-key",
		"--url", `http://127.0.0.1:${port}/echo`,
		"--method", "POST",
		"--header", "Authorization: Bearer {VALUE}",
		"--body", '{"ping":1}',
		"--allow-private", // mock 起在环回上：测试逃生门（brokerCore 默认拒内网/环回/裸 IP，见 sandbox-broker-test）
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
	await run(["credentials/store.mjs", "write", "inject-key", "--owner", "test", "--purpose", "测试钥匙"], { input: V_INJECT });
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
// 8) env-source（T15 活一）：柜优先 / env 过渡回落（出声+记账）/ 双无 undefined
// ---------------------------------------------------------------------------
{
	// 本节专用 helper：跑 node -e 直验 envOrVault（不能用上面的 run()——它给 args[0] 拼
	// repoRoot 前缀，只认 repo 相对路径的脚本名；这里起的是 node 本体）
	const runNode = (code, extraEnv = {}) =>
		new Promise((resolve) => {
			const cp = spawn("node", ["-e", code], {
				cwd: repoRoot,
				env: { ...process.env, ...extraEnv },
				stdio: ["ignore", "pipe", "pipe"],
			});
			let o = "", e = "";
			cp.stdout.on("data", (d) => (o += d));
			cp.stderr.on("data", (d) => (e += d));
			cp.on("close", (code) => resolve({ code, out: o, err: e }));
		});
	const mod = `${repoRoot}/credentials/env-source.mjs`;

	// 8a) 柜有：值走柜（use-vault 落账），env 里的旧明文被无视
	await run(["credentials/store.mjs", "write", "vault-key", "--owner", "test", "--purpose", "测试钥匙"], { input: `${V_VAULT}\n` });
	const r = await runNode(
		`import("${mod}").then(m => process.stdout.write(JSON.stringify({ v: m.envOrVault("X_TEST_KEY", "vault-key") === ${JSON.stringify(V_VAULT)} })))`,
		{ X_TEST_KEY: "ambient-old-plaintext" },
	);
	check2("envOrVault: 柜有 → 值=柜值（env 旧明文被无视，无回落告警）", JSON.parse(r.out || '{"v":false}').v === true && !r.err.includes("过渡回落"));

	// 8b) 柜无 + env 有：过渡回落出声 + env-fallback 落账
	const p2 = await runNode(
		`import("${mod}").then(m => process.stdout.write(m.envOrVault("X_TEST_KEY", "no-such-key")))`,
		{ X_TEST_KEY: "env-fallback-value" },
	);
	check2("envOrVault: 柜无 env 有 → 过渡回落出声（stderr 告警）", p2.err.includes("过渡回落"));
	check2("envOrVault: 回落值=env 值", p2.out.trim() === "env-fallback-value");

	// 8c) 双无：undefined
	const r3 = await runNode(
		`import("${mod}").then(m => process.stdout.write(String(m.envOrVault("X_TEST_KEY", "no-such-key"))))`,
	);
	check2("envOrVault: 双无 → undefined（调用方大声死兜底）", r3.out.trim() === "undefined" && !r3.err.includes("过渡回落"));

	// 8d) 记账：use-vault 与 env-fallback 事件都有且不含值
	const jtext = fs.readFileSync(process.env.PORTALK_CRED_JOURNAL, "utf8");
	check2("envOrVault: use-vault 事件落账（只有名字）", jtext.includes('"action":"use-vault"') && jtext.includes('"name":"vault-key"') && !jtext.includes(V_VAULT));
	check2("envOrVault: env-fallback 事件落账（存量清单面）", jtext.includes('"action":"env-fallback"') && jtext.includes('"name":"no-such-key"'));
}

// ---------------------------------------------------------------------------
// 9) v2（T16）：sidecar 来历（hui三问）、write 强制来历、mask 自动豁免、墓碑闭环、meta 补登、context 落账
//    阴性对照是灵魂：无 sidecar 老钥匙「来历缺失」对照出 v1 答不了；无 context 事件对照出不落空串
// ---------------------------------------------------------------------------
{
	// 9a) hui三问：完整 sidecar 的钥匙，status 一条命令答 谁的/为什么存/scope截至/验证来源+时间
	const r9a = await run([
		"credentials/store.mjs", "write", "huida",
		"--owner", "pianist", "--purpose", "hui考古测试钥匙",
		"--scope", "repo-a,repo-b", "--scope-at", "2026-10-07T00:00:00Z",
		"--verified", "tested", "--verified-at", "2026-10-07T01:02:03Z",
	], { input: "value-huida-77aa88bb\n" });
	check2("v2 write：带全量来历写入成功", r9a.code === 0 && store.has("huida"));
	const st = await run(["credentials/store.mjs", "status"]);
	check2("status 三问：谁的/为什么存（owner+purpose）", st.out.includes("huida") && st.out.includes("pianist") && st.out.includes("hui考古测试钥匙"));
	check2("status 三问：管哪些仓截至何时（scope+快照时刻）", st.out.includes("repo-a") && st.out.includes("repo-b") && st.out.includes("2026-10-07T00:00:00Z"));
	check2("status 三问：验证来源+时间（tested）", st.out.includes("tested") && st.out.includes("2026-10-07T01:02:03Z"));

	// 9b) 阴性对照：v1 老钥匙（裸文件无 sidecar）——来历缺失、不炸、stderr 提醒补登（v1 答不了，v2 出声）
	fs.writeFileSync(path.join(process.env.PORTALK_CRED_DIR, "legacy-key"), "legacy-value-1122334455", { mode: 0o600 });
	check2("老钥匙兼容：has/readValue/list 照旧", store.has("legacy-key") && store.readValue("legacy-key") === "legacy-value-1122334455" && store.list().includes("legacy-key"));
	const st2 = await run(["credentials/store.mjs", "status"]);
	check2("老钥匙 status：显示来历缺失且不炸（阴性对照）", st2.code === 0 && st2.out.includes("legacy-key") && st2.out.includes("来历缺失") && !st2.out.includes("legacy-value"));
	check2("老钥匙 status：stderr 出声提醒补登", st2.err.includes("legacy-key") && st2.err.includes("补登"));
	const stj = await run(["credentials/store.mjs", "status", "--json"]);
	const jd = JSON.parse(stj.out);
	const jhuida = jd.keys.find((k) => k.name === "huida");
	const jlegacy = jd.keys.find((k) => k.name === "legacy-key");
	check2(
		"status --json：机器读字段齐（owner/scope/snapshot/last_verified）",
		jhuida && jhuida.meta === true && jhuida.owner === "pianist" && Array.isArray(jhuida.scope) && jhuida.scope.join(",") === "repo-a,repo-b" && jhuida.scope_snapshot_at === "2026-10-07T00:00:00Z" && jhuida.last_verified.source === "tested" && jhuida.last_verified.at === "2026-10-07T01:02:03Z",
	);
	check2("status --json：老钥匙 meta:false 不炸", jlegacy && jlegacy.meta === false);

	// 9c) write 强制来历闸：CLI 缺 owner/purpose exit 2 出声；API 缺 meta 抛错且不落库（强制闸不是建议）
	const noOwner = await run(["credentials/store.mjs", "write", "no-owner", "--purpose", "x"], { input: "vvvv-1111\n" });
	check2("write CLI 缺 owner 拒绝（exit 2 出声）", noOwner.code === 2 && noOwner.err.includes("owner"));
	const noPurpose = await run(["credentials/store.mjs", "write", "no-purpose", "--owner", "x"], { input: "vvvv-2222\n" });
	check2("write CLI 缺 purpose 拒绝（exit 2 出声）", noPurpose.code === 2 && noPurpose.err.includes("purpose"));
	let threw = false;
	try { store.write("no-meta", "vvvv-3333"); } catch { threw = true; }
	check2("write API 缺来历抛错且不落库（强制闸）", threw && !store.has("no-meta"));
	const badVer = await run(["credentials/store.mjs", "write", "bad-ver", "--owner", "x", "--purpose", "y", "--verified", "maybe"], { input: "vvvv-4444\n" });
	check2("write CLI --verified 非二值拒绝（不许混称）", badVer.code === 2 && badVer.err.includes("declared"));

	// 9d) mask 自动落库豁免：unnamed-* 自带 owner=auto-mask，status 可见
	const { found: mf } = maskText("网关密码是 mauto-77ff889900aa 请收好");
	const st3 = await run(["credentials/store.mjs", "status"]);
	check2("mask 落库 unnamed-* 自动带 owner=auto-mask（status 可见）", mf.length === 1 && /^unnamed-[0-9a-f]{8}$/.test(mf[0].name) && st3.out.includes("auto-mask"));

	// 9e) 墓碑闭环：destroy → 无此钥 + 墓碑（指纹+死因+时间）+ journal 照旧；同名复活清墓碑
	const dk = await run(["credentials/store.mjs", "destroy", "huida", "--reason", "考古测试完毕"]);
	const tombP = path.join(process.env.PORTALK_CRED_DIR, "meta", "huida.tombstone.json");
	const tomb = JSON.parse(fs.readFileSync(tombP, "utf8"));
	check2("墓碑：柜内无此钥", dk.code === 0 && store.has("huida") === false);
	check2("墓碑：文件在场含 name+指纹+死因+时间", tomb.name === "huida" && /^[0-9a-f]{8}$/.test(tomb.fingerprint) && tomb.reason === "考古测试完毕" && !Number.isNaN(Date.parse(tomb.ts)));
	check2("墓碑：指纹=销毁时刻值的 sha256 前 8", tomb.fingerprint === createHash("sha256").update("value-huida-77aa88bb").digest("hex").slice(0, 8));
	check2("墓碑：journal destroy 照旧落账", fs.readFileSync(process.env.PORTALK_CRED_JOURNAL, "utf8").includes('"action":"destroy"'));
	const sts = await run(["credentials/store.mjs", "status"]);
	check2("status：墓碑区单独一段（死因+指纹可见）", sts.out.includes("墓碑") && sts.out.includes("考古测试完毕") && sts.out.includes(tomb.fingerprint));
	const revive = await run(["credentials/store.mjs", "write", "huida", "--owner", "pianist", "--purpose", "复活测试"], { input: "value-huida-2-99bb00cc\n" });
	check2("同名复活：write 成功 + 墓碑消失", revive.code === 0 && store.has("huida") === true && !fs.existsSync(tombP));

	// 9f) meta 子命令：merge 语义（传啥改啥，不传保留）——老钥匙补登用
	const mUpd = await run(["credentials/store.mjs", "meta", "huida", "--scope", "repo-c", "--verified", "declared"]);
	const mAfter = store.readMeta("huida");
	check2("meta 子命令：传的字段改了（scope 刷新+快照时刻自动到写时刻）", mUpd.code === 0 && Array.isArray(mAfter.scope) && mAfter.scope.join(",") === "repo-c" && mAfter.scope_snapshot_at !== "2026-10-07T00:00:00Z");
	check2("meta 子命令：不传的字段保留（owner/purpose 不动）", mAfter.owner === "pianist" && mAfter.purpose === "复活测试");
	check2("meta 子命令：verified 覆盖带来源与时间", mAfter.last_verified.source === "declared" && !Number.isNaN(Date.parse(mAfter.last_verified.at)));
	const mOld = await run(["credentials/store.mjs", "meta", "legacy-key", "--owner", "pianist", "--purpose", "考古补登 v1 遗留钥匙"]);
	check2("meta 子命令：老钥匙补登（来历缺失→有档）", mOld.code === 0 && store.readMeta("legacy-key").owner === "pianist");
	check2("meta 子命令：落 meta 事件（考古可查谁补的档）", fs.readFileSync(process.env.PORTALK_CRED_JOURNAL, "utf8").includes('"action":"meta"'));

	// 9g) context 落账：带 context 的 use 事件有该字段；不带没有（两边都断言，不许空串/undefined 混账）
	const mod = `${repoRoot}/credentials/env-source.mjs`;
	const runNode9 = (code) =>
		new Promise((resolve) => {
			const cp = spawn("node", ["-e", code], { cwd: repoRoot, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
			cp.on("close", (c) => resolve({ code: c }));
		});
	await runNode9(`import("${mod}").then(m => m.envOrVault("X_CTX", "legacy-key", "conductor:test(ctx)"))`);
	const injT = await run(["credentials/inject.mjs", "--env", "MYTOK=inject-key", "--task", "test:inject-task", "--", "node", "-e", "process.exit(0)"]);
	check2("inject --task：exit 0", injT.code === 0);
	{ // broker --task：起简版 mock（环回需 --allow-private，同 section 6 夹具纪律）
		const srv = http.createServer((req, res) => res.end("{}"));
		await new Promise((r) => srv.listen(0, "127.0.0.1", r));
		const br = await run([
			"credentials/broker.mjs", "--name", "broker-key", "--url", `http://127.0.0.1:${srv.address().port}/x`,
			"--header", "Authorization: Bearer {VALUE}", "--task", "test:broker-task", "--allow-private",
		]);
		check2("broker --task：exit 0", br.code === 0);
		srv.close();
	}
	const raw9 = fs.readFileSync(process.env.PORTALK_CRED_JOURNAL, "utf8");
	const lines9 = raw9.trim().split("\n").map((l) => JSON.parse(l));
	const ctxVault = lines9.find((l) => l.action === "use-vault" && l.context === "conductor:test(ctx)");
	const ctxInj = lines9.find((l) => l.action === "use-inject" && l.context === "test:inject-task");
	const ctxBrk = lines9.find((l) => l.action === "use-broker" && l.context === "test:broker-task");
	check2("context 落账：use-vault 带 context（envOrVault 第三参）", Boolean(ctxVault) && ctxVault.name === "legacy-key");
	check2("context 落账：use-inject 带 context（inject --task）", Boolean(ctxInj) && ctxInj.name === "inject-key");
	check2("context 落账：use-broker 带 context（broker --task）", Boolean(ctxBrk) && ctxBrk.name === "broker-key");
	const noCtx = lines9.filter((l) => (l.action === "use-vault" || l.action === "use-inject" || l.action === "use-broker") && !("context" in l));
	check2("context 阴性对照：不带 context 的 use 事件无该字段（无空串/undefined 混账）", noCtx.length >= 3 && !raw9.includes('"context":undefined') && !raw9.includes('"context":""'));
}

// ---------------------------------------------------------------------------
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`新增检查 ${total} 项，${pass === total ? "全绿" : "有红"}`);
console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
