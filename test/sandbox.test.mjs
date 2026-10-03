// 施工⑦第一铲测试：轻档沙箱引擎（Landlock+Seccomp+netns）——真内核原语、真出网、真记账
// 验证链（任务书§5逐条）：
//   1) 引导器可编译；执行器跑 node -e 'ok' 出 ok
//   2) Landlock 挡 /mnt/c（the user Windows 目录物理不可达，ENOENT/EACCES）
//   3) Landlock 挡 REPO_HOME 之外的 /root（读 /.bashrc EACCES）
//   4) Landlock 放行 repo 自身读写（施工期自见）+ 暂存区可写
//   5) Seccomp 拒 mount（EPERM）+ 拒 unshare（顺序证明：自己的 netns 先开完才装过滤器）
//   6) netns：ip addr 只见 lo；连 127.6.6.6:9999 被拒
//   7) 白名单代理：registry.npmjs.org 200；经代理裸 IP → 403；绕代理直连内网 → 物理断路
//   8) 先通后报：白名单外域名（example.com/example.net）放行 + journal 落账
//   9) 真跑一回合：fixture-project 沙箱内 npm install && npm test 全绿
//  10) 残留：无孤儿进程、无 /tmp/sandbox-scratch-* 残留、iptables 规则前后一致（本引擎不碰 iptables）
// 运行：node test/sandbox.test.mjs（需 root + Landlock 内核；已挂进 npm test）

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureLauncher } from "../sandbox/executor.mjs";
import { countJournalLines } from "../sandbox/journal.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const POLICY = "sandbox/policies/default.policy.json";
const JOURNAL = path.join(ROOT, "data", "sandbox-journal.jsonl");

let pass = 0;
let total = 0;
function check(name, ok) {
	total++;
	if (ok) pass++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

/** 起一个沙箱回合（黑盒走 CLI 契约：node sandbox/run-sandboxed.mjs --policy ... -- cmd） */
function sandbox(cmd, { timeoutMs = 60_000 } = {}) {
	return new Promise((resolve) => {
		const child = spawn(
			"node",
			["sandbox/run-sandboxed.mjs", "--policy", POLICY, "--timeout-ms", String(timeoutMs), "--", ...cmd],
			{ cwd: ROOT },
		);
		let out = "";
		let err = "";
		child.stdout.on("data", (c) => (out += c));
		child.stderr.on("data", (c) => (err += c));
		child.on("close", (code) => resolve({ code, stdout: out, stderr: err }));
		child.on("error", (e) => resolve({ code: -1, stdout: out, stderr: String(e) }));
	});
}

const iptablesSnapshot = () => {
	const r = spawnSync("iptables-save", [], { encoding: "utf8" });
	if (r.status !== 0) return null;
	// 规范化：去掉时间戳注释与链内建计数器（它们自然漂动，不是规则）
	return r.stdout
		.split("\n")
		.filter((l) => !l.startsWith("#"))
		.map((l) => l.replace(/\[\d+:\d+\]/g, "[]"))
		.join("\n");
};

console.log(`[sandbox-test] 本机 uid=${process.getuid()}（引擎需要 root；Landlock ABI 由引导器报错兜底）`);
const IPT_BEFORE = iptablesSnapshot();

// ---- 1) 引导器 + 基线 ----
{
	let binOk = true;
	try {
		const bin = ensureLauncher();
		binOk = fs.existsSync(bin);
	} catch (e) {
		binOk = false;
		console.error(`[sandbox-test] 引导器编译失败：${e.message}`);
	}
	check("引导器：launcher.c 可编译出 bin/sandbox-launcher", binOk);
}
{
	const r = await sandbox(["node", "-e", "console.log('ok uid=' + process.getuid())"]);
	check(
		`基线：沙箱内 node -e 出 ok 且降权 nobody — code=${r.code} out=${r.stdout.trim()}`,
		r.code === 0 && r.stdout.includes("ok") && r.stdout.includes("uid=65534"),
	);
}

// ---- 2) Landlock 挡 /mnt/c ----
{
	const dir = "/mnt/c/Users/winuser";
	const entries = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
	const file = entries.find((f) => fs.statSync(path.join(dir, f)).isFile());
	check(`前置：宿主侧能见到 ${dir} 下的真实文件（${file ?? "无"}）`, Boolean(file));
	if (file) {
		const r = await sandbox(["cat", path.join(dir, file)]);
		check(
			`Landlock：读 ${dir}/${file} 被拒（${(r.stderr.match(/denied|such file/i) ?? ["?"])[0]}）`,
			r.code !== 0 && /permission denied|no such file/i.test(r.stderr),
		);
	}
}

// ---- 3) Landlock 挡 repo 外的 /root ----
{
	const r = await sandbox(["cat", "/.bashrc"]);
	check(
		`Landlock：读 /.bashrc 被拒（EACCES）`,
		r.code !== 0 && /permission denied/i.test(r.stderr),
	);
}

// ---- 4) Landlock 放行 repo 自身 + 暂存区 ----
{
	// 写入面用 fixture 目录（回合前 chown 给 nobody，与验收回合同款姿势）；读面用 repo 根
	const fixture = path.join(ROOT, "test/fixture-project");
	spawnSync("chown", ["-R", "65534:65534", fixture]);
	const r = await sandbox([
		"node",
		"-e",
		"const fs=require('fs');fs.readFileSync('package.json');" +
			"fs.writeFileSync(process.env.PORTALK_SANDBOX_SCRATCH+'/w','hi');" +
			"fs.appendFileSync('test/fixture-project/.sbx-touch','x');console.log('rw-ok')",
	]);
	fs.rmSync(path.join(fixture, ".sbx-touch"), { force: true });
	check(`Landlock：repo 自身可读写、scratch 可写 — code=${r.code} out=${r.stdout.trim()}`, r.code === 0 && /rw-ok/.test(r.stdout));
}

// ---- 5) Seccomp 拒重特权 ----
{
	const r = await sandbox(["mount", "-t", "tmpfs", "none", "/tmp"]);
	check(
		`Seccomp：mount -t tmpfs 被拒（EPERM）— code=${r.code}`,
		r.code !== 0 && /must be superuser|permission denied|EPERM/i.test(r.stderr),
	);
}
{
	const r = await sandbox(["unshare", "-n", "true"]);
	check(
		`Seccomp：沙箱内再 unshare 被拒（EPERM，证明引导器先开完自己的 netns 才装过滤器）— code=${r.code}`,
		r.code !== 0 && /operation not permitted|EPERM/i.test(r.stderr),
	);
}

// ---- 6) netns 隔离 ----
{
	const r = await sandbox(["ip", "-o", "addr"]);
	check(
		`netns：ip addr 只见 lo — ${r.stdout.trim().split("\n").length} 行`,
		r.code === 0 && /lo/.test(r.stdout) && !/eth\d|enp\w+|ens\w+|wlan\d/.test(r.stdout),
	);
}
{
	const r = await sandbox([
		"node",
		"-e",
		"require('net').connect(9999,'127.6.6.6').on('error',e=>{console.error('ERRTYPE',e.code);process.exit(3)}).on('connect',()=>process.exit(0))",
	]);
	check(
		`netns：连 127.6.6.6:9999 被拒（${(r.stderr.match(/ERRTYPE (\S+)/) ?? [])[1] ?? "?"}）`,
		r.code !== 0,
	);
}

// ---- 7) 白名单代理 ----
{
	const r = await sandbox(["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "30", "https://registry.npmjs.org/"]);
	check(`代理：白名单 registry.npmjs.org 经门禁 200 — ${r.stdout.trim()}`, r.code === 0 && r.stdout.trim() === "200");
}
{
	const r = await sandbox(["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", "http://10.255.255.1/"]);
	check(`代理：经代理连裸 IP 10.255.255.1 被门禁 403 硬拒 — ${r.stdout.trim()}`, r.code === 0 && r.stdout.trim() === "403");
}
{
	const r = await sandbox(["curl", "--noproxy", "*", "-sS", "-o", "/dev/null", "--connect-timeout", "4", "http://192.168.1.1/"]);
	check(`代理：绕代理直连内网 192.168.1.1 物理断路 — code=${r.code}`, r.code !== 0);
}

// ---- 8) 先通后报 ----
{
	const before = countJournalLines(JOURNAL);
	const r1 = await sandbox(["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "30", "https://example.com/"]);
	const r2 = await sandbox(["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "30", "https://example.net/"]);
	const after = countJournalLines(JOURNAL);
	const lines = fs
		.readFileSync(JOURNAL, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.slice(-2);
	const hosts = lines.map((l) => { try { return JSON.parse(l).host; } catch { return null; } });
	const scopeOk = lines.every((l) => { try { return JSON.parse(l).scope === "sandbox-new-endpoint"; } catch { return false; } });
	check(
		`先通后报：example.com/example.net 放行（${r1.stdout.trim()}/${r2.stdout.trim()}）且 journal 新落账 ${after - before} 行（${hosts.join(",")}）`,
		r1.code === 0 &&
			r1.stdout.trim() === "200" &&
			r2.code === 0 &&
			r2.stdout.trim() === "200" &&
			after - before >= 2 &&
			scopeOk &&
			hosts.includes("example.com") &&
			hosts.includes("example.net"),
	);
}

// ---- 9) 真跑一回合：fixture-project 沙箱内 npm install && npm test ----
{
	const fixture = path.join(ROOT, "test/fixture-project");
	fs.rmSync(path.join(fixture, "node_modules"), { recursive: true, force: true });
	fs.rmSync(path.join(fixture, "package-lock.json"), { force: true });
	spawnSync("chown", ["-R", "65534:65534", fixture]);
	const r = await sandbox(
		["sh", "-c", "cd test/fixture-project && npm install --no-audit --no-fund && npm test"],
		{ timeoutMs: 240_000 },
	);
	check(
		`真跑一回合：沙箱内 npm install && npm test 全绿 — code=${r.code} ${r.stdout.includes("fixture-ok") ? "fixture-ok" : r.stdout.slice(-120)}`,
		r.code === 0 && /fixture-ok/.test(r.stdout),
	);
	// 收尾：清掉 npm 产物、归还属主（不留非源文件在工作区）
	fs.rmSync(path.join(fixture, "node_modules"), { recursive: true, force: true });
	fs.rmSync(path.join(fixture, "package-lock.json"), { force: true });
	spawnSync("chown", ["-R", "root:root", fixture]);
}

// ---- 10) 残留检查 ----
{
	const scratchLeft = fs
		.readdirSync("/tmp")
		.filter((f) => f.startsWith("sandbox-scratch-"));
	check(`残留：/tmp 无 sandbox-scratch-* 残留 — ${scratchLeft.length ? scratchLeft.join(",") : "干净"}`, scratchLeft.length === 0);

	const pg = (pattern) => spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" });
	const orphans = ["sandbox/netns-relay.mjs", "sandbox/run-sandboxed.mjs", "sandbox-launcher"]
		.filter((p) => pg(p).status === 0)
		.join(",");
	check(`残留：无沙箱孤儿进程 — ${orphans || "干净"}`, orphans === "");

	const IPT_AFTER = iptablesSnapshot();
	check(
		"残留：iptables 规则前后一致（本引擎全程不碰 iptables/nftables）",
		IPT_BEFORE !== null && IPT_AFTER === IPT_BEFORE,
	);
}

// 自检：journal 至少两条真实记录（施工测试产生的，不编造）
{
	const n = countJournalLines(JOURNAL);
	check(`记账：data/sandbox-journal.jsonl 已有 ${n} 条真实放行记录（>=2）`, n >= 2);
}

console.log(`${pass}/${total} passed`);
if (pass !== total) process.exit(1);
