// 洞4（洄洄 #708 裁决「输入侧补，补的是名字不是名录」）：draft 近亲名单进分身 prompt。
// 本测试不拉真分身（key 不在环境也能跑）——单独验证 retropad 的名单提取/缩写/降级三件事：
//   1) darkzone 返回文本里的 draft 行被正确过滤+缩写（首词+确定性hash前4）
//   2) 非 draft 行（verified/canon 等）不进名单
//   3) 壳不可达时：出声降级（warn），分身照常拉起（出声≠中断）
// 与 retropad.mjs 的实现保持同构：实现改了这里要跟着改。
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PI_BIN = path.join(ROOT, "node_modules", ".bin", "pi");

// ---- 与 retropad.mjs 同构的两个纯函数（复制而非 import——retropad 是脚本不是模块，顶层有副作用） ----
function abbreviate(name) {
	let h = 0;
	for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return `${name.split("-")[0]}~${h.toString(16).slice(0, 4)}`;
}
function extractDrafts(text) {
	const drafts = [];
	for (const line of text.split("\n")) {
		const m = line.match(/^(\S+)\s+\[(\S+)\/(\S+)\]/);
		if (m && m[3] === "draft") drafts.push(m[1]);
	}
	return drafts;
}

const darkzoneText = [
	"暗区点名(从未被push/expand):",
	"env-facts-probe  [draft层/draft]",
	"env-probe-session-cache  [draft层/draft]",
	"some-verified-skill  [canon/verified]",
	"",
	"出口提醒: 名单是机械的, 逐本判断仍是巡山使的活。",
].join("\n");

const checks = [];

// 1) draft 过滤：只留 draft 行
const drafts = extractDrafts(darkzoneText);
checks.push(["draft 行过滤（2 本，verified 不进）", drafts.length === 2 && drafts[0] === "env-facts-probe" && drafts[1] === "env-probe-session-cache"]);

// 2) 缩写：首词+hash前4，确定性（同输入同输出）
const a1 = abbreviate("env-facts-probe");
const a2 = abbreviate("env-probe-session-cache");
checks.push(["缩写形状（首词~4hex）", /^env~[0-9a-f]{4}$/.test(a1) && a1 !== a2 && abbreviate("env-facts-probe") === a1]);

// 3) 真 mock 壳走一遍 retropad 主流程（零热点报告 → 闸门三：不拉 pi，exit 0——只验名单拉取出声）
const mockShell = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => { body += c; });
	req.on("end", () => {
		const ok = JSON.stringify({ status: 200, body: darkzoneText });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(ok);
	});
});
await new Promise((r) => mockShell.listen(18771, "127.0.0.1", r));

const tmpReport = `/tmp/dong4-report-${Date.now()}.json`;
// 一条错误热点（非零热点——零热点走闸门三提前收工，roster 拉取不会发生；pi 无 key exit 3 不影响 roster 断言）
await fs_write(tmpReport, JSON.stringify({
	v: 1, hotspots: [],
	errorHotspots: [{ agent: "pianist-dev-2", count: 4, shape: "bash:npm test*", firstTs: "t0", lastTs: "t1", evidence: [{ file: "/tmp/x.jsonl", line: 1 }] }],
}));

let warnSeen = false;
const origWarn = console.warn;
console.warn = (...a) => { if (String(a[0]).includes("draft")) warnSeen = true; origWarn(...a); };

// 3a) 壳活：名单拉到（有 console.log「近亲名单」）——pi 无 key exit 3 是预期，只验 roster 出声
const r1 = await runRetropad(["--report", tmpReport], { PIANIST_SHELL_URL: "http://127.0.0.1:18771" });
checks.push(["壳活：名单拉到且出声（2 本）", r1.out.includes("draft 近亲名单：2 本")]);

// 3b) 壳死：出声降级 warn，分身拉起照旧（pi exit 3 无 key 预期，验的是降级出声+不静默）
const r2 = await runRetropad(["--report", tmpReport], { PIANIST_SHELL_URL: "http://127.0.0.1:18799" });
checks.push(["壳死：降级 warn 出声", r2.err.includes("名单拉取失败")]);
checks.push(["壳死：仍 exit 0（不中断）", r2.code === 0 || r2.code === 3]); // 0=闸门三提前收工；3=pi无key——都不是 roster 中断
console.warn = origWarn;
mockShell.close();

let pass = 0;
for (const [name, ok] of checks) {
	console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
	if (ok) pass += 1;
}
console.log(`PASS ${pass}/${checks.length}`);
process.exit(pass === checks.length ? 0 : 1);

// ---- helpers ----
function fs_write(p, content) {
	return import("node:fs").then((m) => m.promises.writeFile(p, content));
}
function runRetropad(argv, envOverrides) {
	return new Promise((resolve) => {
		const child = spawn("node", [path.join(ROOT, "src", "retropad.mjs"), ...argv], {
			cwd: ROOT,
			env: { ...process.env, ...envOverrides },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "", err = "";
		child.stdout.on("data", (d) => { out += d.toString(); });
		child.stderr.on("data", (d) => { err += d.toString(); });
		child.on("close", (code) => resolve({ code, out, err }));
	});
}
