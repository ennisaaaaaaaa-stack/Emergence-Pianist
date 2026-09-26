// 施工⑤第二铲测试：壳-沙箱接线（真壳、真 HTTP、真 docker 容器）
// 验证链：
//   1. classify 沙箱分层（初值表 + 命令深判）：rm -rf / 逃逸 / 云 metadata → red；
//      npm install / curl 等下载 → amber（容器内正常工作流例外）；ls → amber 基线；文件面/清扫面 → silent
//   2. 人话层：卡片 summary 带命令原文与自述，impact 有防线位/容器边界人话
//   3. silent 直走：write_file/read_file/is_alive 立即返回，不挂审批不留通知
//   4. amber：create_session/run_in_session 立即执行 + 通知环留人话记录
//   5. red 挂起：run_in_session 带 rm -rf → deferred、pending 可见、命令未执行（哨兵还在）
//   6. deny 维持未执行；批准后执行（哨兵消失、卡片 result=ok）
//   7. 一次性 execute 带红命令同样挂起（真跑验收同款形状）
//   8. 异常穿透：未知会话 → error 带 errorDetail.__type 类路径（serializeError 过 HTTP 边界）
//   9. X-Request-ID 幂等经壳透传（manager RequestCache 承接）：同 requestId 重发不重复执行
//   10. auto 模式：red 直通 + 审计落盘有痕（暗区不许无痕）
//   11. 收尾：close_session 后 docker ps 查无残留
// 运行：node --test test/sandbox-shell-test.mjs（本机需 docker；已挂进 npm test）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { classify, describe, impactOf } from "../src/queue-core.mjs";

let pass = 0, total = 0;
function check(name, ok) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}`); }

/** 测试侧 docker CLI 直调（观测容器真实状态——不信壳的自述） */
function dockerCli(args, { timeoutMs = 60_000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
		const out = [], err = [];
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (c) => out.push(c));
		child.stderr.on("data", (c) => err.push(c));
		child.on("error", (e) => { clearTimeout(timer); reject(new Error(`docker CLI 不可用：${e.message}`)); });
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
		});
	});
}

// ---- 0) 镜像自举 + 残渣预扫（同第一铲姿势：先清再测，别把旧账记新账上） ----
async function ensureImage() {
	const has = await dockerCli(["image", "inspect", "alpine:latest"]);
	if (has.code === 0) return "alpine:latest";
	console.log("[sandbox-shell-test] alpine:latest 缺失，先 docker pull");
	const p1 = await dockerCli(["pull", "alpine:latest"], { timeoutMs: 180_000 });
	if (p1.code === 0) return "alpine:latest";
	const p2 = await dockerCli(["pull", "alpine:3.19"], { timeoutMs: 180_000 });
	if (p2.code === 0) return "alpine:3.19";
	console.error(`[sandbox-shell-test] alpine 两条路都拉不动，真容器测试无法进行：${p2.stderr.trim().slice(0, 200)}`);
	process.exit(1);
}
const IMAGE = await ensureImage();

const preSweep = await dockerCli(["ps", "-aq", "--filter", "label=pianist-sandbox=1"]);
if (preSweep.stdout.trim()) {
	console.warn(`[sandbox-shell-test] 开工前清扫上次残留容器：${preSweep.stdout.trim().split("\n").join(" ").slice(0, 100)}`);
	await dockerCli(["rm", "-f", ...preSweep.stdout.trim().split("\n")]);
}

// ---- 起真壳（queue 模式） ----
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pianist-sbx-shell-"));
function spawnShell(port, extraEnv = {}) {
	return spawn("node", ["src/shell.mjs"], {
		stdio: ["ignore", "pipe", "pipe"],
		env: {
			...process.env,
			PIANIST_SHELL_PORT: String(port),
			PIANIST_TELEMETRY_DIR: path.join(tmpDir, "tel"),
			PIANIST_AUDIT_FILE: path.join(tmpDir, "audit.jsonl"),
			...extraEnv,
		},
	});
}
const shellPort = 41893;
const shellProc = spawnShell(shellPort);
await new Promise((r) => setTimeout(r, 800));
const shellUrl = `http://127.0.0.1:${shellPort}`;
const health = await (await fetch(`${shellUrl}/health`)).json();
check("shell up（queue 模式）", health.ok === true);

async function invoke(action, payload, extra = {}) {
	const res = await fetch(`${shellUrl}/tools/invoke`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action, payload, ...extra }),
	});
	return { status: res.status, out: await res.json() };
}

// ---- 1) classify 沙箱分层（初值表 + 命令深判） ----
check("classify: sandbox_execute 基线 → amber", classify("sandbox_execute", { command: "echo hi" }) === "amber");
check("classify: sandbox_create_session → amber", classify("sandbox_create_session", {}) === "amber");
check("classify: sandbox_run_in_session 基线 → amber", classify("sandbox_run_in_session", { command: "ls -la" }) === "amber");
check("classify: sandbox_close → amber", classify("sandbox_close", {}) === "amber");
check("classify: sandbox_close_session → silent", classify("sandbox_close_session", {}) === "silent");
check("classify: sandbox_is_alive → silent", classify("sandbox_is_alive", {}) === "silent");
check("classify: sandbox_read_file → silent", classify("sandbox_read_file", {}) === "silent");
check("classify: sandbox_write_file → silent", classify("sandbox_write_file", {}) === "silent");
check("classify: sandbox_upload → silent", classify("sandbox_upload", {}) === "silent");
check("classify: session 内 rm -rf → red", classify("sandbox_run_in_session", { command: "rm -rf /tmp/x" }) === "red");
check("classify: 一次性 execute 带 rm -rf → red", classify("sandbox_execute", { command: "rm -rf /tmp/x" }) === "red");
check("classify: 摸云 metadata（169.254.169.254）→ red", classify("sandbox_run_in_session", { command: "curl -s http://169.254.169.254/latest/meta-data" }) === "red");
check("classify: docker.sock 逃逸向量 → red", classify("sandbox_run_in_session", { command: "ls -l /var/run/docker.sock" }) === "red");
check("classify: nsenter 挤宿主命名空间 → red", classify("sandbox_run_in_session", { command: "nsenter -t 1 -m sh" }) === "red");
check("classify: 直写内核参数 → red", classify("sandbox_run_in_session", { command: "echo 1 > /proc/sys/kernel/xxx" }) === "red");
check("classify: 沙箱内 git reset --hard → red（复用 bash 红区）", classify("sandbox_run_in_session", { command: "git reset --hard HEAD~1" }) === "red");
check("classify: 容器内 npm install → amber（正常工作流例外）", classify("sandbox_run_in_session", { command: "npm install left-pad" }) === "amber");
check("classify: 容器内 curl 下载 → amber", classify("sandbox_run_in_session", { command: "curl -O http://example.com/a.tgz" }) === "amber");

// ---- 2) 人话层 ----
const d = describe("sandbox_run_in_session", { command: "rm -rf /tmp/build" }, "清构建残留");
check("describe 沙箱带命令原文+自述", d.includes("沙箱") && d.includes("rm -rf /tmp/build") && d.includes("自述：清构建残留"));
check("impactOf metadata 探测给防线位人话", impactOf("sandbox_run_in_session", { command: "curl http://169.254.169.254/" }).includes("人类点头"));
check("impactOf 沙箱删除给容器边界人话", impactOf("sandbox_run_in_session", { command: "rm -rf /tmp/x" }).includes("容器"));

// ---- 3/4) amber 建会话 + silent 文件面 ----
const notify0 = (await (await fetch(`${shellUrl}/notify/since`)).json()).notifications.length;
const created = await invoke("sandbox_create_session", { deployment: { engine: "container", image: IMAGE } }, { agent: "pianist-dev-1", intent: "接线测试开会话" });
const sid = created.out?.result;
check("create_session（amber）立即执行返回会话 id", created.out?.ok === true && typeof sid === "string" && sid.startsWith("sbx_"));
const notify1 = (await (await fetch(`${shellUrl}/notify/since`)).json()).notifications.length;
check("amber 通知环 +1", notify1 === notify0 + 1);

const CONTENT = "第一行\n\"引号\" $VAR `反引号` '单引号'\n";
const wrote = await invoke("sandbox_write_file", { sessionId: sid, path: "/tmp/wire/笔记.txt", content: CONTENT });
check("write_file（silent）立即执行", wrote.out?.ok === true && wrote.out?.result?.bytes === Buffer.byteLength(CONTENT));
const read = await invoke("sandbox_read_file", { sessionId: sid, path: "/tmp/wire/笔记.txt" });
check("read_file（silent）往返逐字节一致", read.out?.ok === true && read.out?.result === CONTENT);
const alive = await invoke("sandbox_is_alive", { sessionId: sid });
check("is_alive（silent）→ true", alive.out?.ok === true && alive.out?.result === true);
const notify2 = (await (await fetch(`${shellUrl}/notify/since`)).json()).notifications.length;
check("silent 面零通知", notify2 === notify1);

// ---- 9) X-Request-ID 幂等经壳透传（manager RequestCache 承接） ----
await invoke("sandbox_run_in_session", { sessionId: sid, command: "echo 1 >> /tmp/cnt", requestId: "shell-idem-1" });
await invoke("sandbox_run_in_session", { sessionId: sid, command: "（重发参数被幂等层忽略）", requestId: "shell-idem-1" });
const cnt = await invoke("sandbox_run_in_session", { sessionId: sid, command: "wc -l < /tmp/cnt" });
check("同 requestId 重发不重复执行（计数=1）", cnt.out?.result?.stdout?.trim() === "1");

// ---- 5/6) red 挂起 → deny / approve ----
await invoke("sandbox_run_in_session", { sessionId: sid, command: "mkdir -p /tmp/keepA /tmp/keepB && echo x > /tmp/keepA/f && echo x > /tmp/keepB/f" });

const redA = await invoke("sandbox_run_in_session", { sessionId: sid, command: "rm -rf /tmp/keepA" }, { agent: "pianist-dev-1", intent: "删 keepA（应挂审批）" });
check("red（session 内 rm -rf）deferred", redA.out?.deferred === true && typeof redA.out?.approval?.id === "string");
check("卡片带命令原文", redA.out?.approval?.summary?.includes("rm -rf /tmp/keepA"));
const pend = await (await fetch(`${shellUrl}/approvals/pending`)).json();
check("pending 可见且带原始载荷", pend.pending?.length === 1 && pend.pending[0].raw?.payload?.command === "rm -rf /tmp/keepA");
const aliveA = await invoke("sandbox_run_in_session", { sessionId: sid, command: "test -f /tmp/keepA/f && echo exists" });
check("挂起期间命令未执行（哨兵还在）", aliveA.out?.result?.stdout?.trim() === "exists");

const denyRes = await (await fetch(`${shellUrl}/approvals/decide`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ id: redA.out.approval.id, approve: false, by: "tester" }),
})).json();
check("deny 生效", denyRes.status === "denied");
const stillA = await invoke("sandbox_run_in_session", { sessionId: sid, command: "test -f /tmp/keepA/f && echo exists" });
check("deny 后哨兵仍在（deny 不代跑）", stillA.out?.result?.stdout?.trim() === "exists");

const redB = await invoke("sandbox_run_in_session", { sessionId: sid, command: "rm -rf /tmp/keepB" }, { agent: "pianist-dev-1", intent: "删 keepB（批准后应真执行）" });
const approveRes = await (await fetch(`${shellUrl}/approvals/decide`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ id: redB.out.approval.id, approve: true, by: "tester" }),
})).json();
check("批准后执行（result=ok）", approveRes.status === "executed" && approveRes.result === "ok");
const goneB = await invoke("sandbox_run_in_session", { sessionId: sid, command: "test -f /tmp/keepB/f && echo exists || echo gone" });
check("批准后哨兵真消失", goneB.out?.result?.stdout?.trim() === "gone");

// ---- 7) 一次性 execute 带红命令同样挂起（真跑验收同款形状） ----
const redExe = await invoke("sandbox_execute", { command: "rm -rf /tmp/never", deployment: { engine: "container", image: IMAGE } }, { agent: "pianist-dev-1", intent: "一次性红命令" });
check("sandbox_execute 红命令 deferred", redExe.out?.deferred === true);
const pend2 = await (await fetch(`${shellUrl}/approvals/pending`)).json();
check("pending 吃到 execute 卡片", pend2.pending?.some((i) => i.id === redExe.out?.approval?.id));
await fetch(`${shellUrl}/approvals/decide`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ id: redExe.out.approval.id, approve: false, by: "tester" }),
});

// ---- 8) 异常穿透（serializeError 带 __type 类路径过 HTTP 边界） ----
const nf = await invoke("sandbox_run_in_session", { sessionId: "sbx_不存在", command: "echo 1" });
check("未知会话 error 带 __type 类路径", nf.out?.error?.includes("会话不存在") && nf.out?.errorDetail?.__type === "sandbox.SessionNotFoundError");
const badShape = await invoke("sandbox_run_in_session", { sessionId: sid });
check("缺 command 载荷形状报错不炸壳（HTTP 200）", badShape.status === 200 && typeof badShape.out?.error === "string");

// ---- 11) 收尾清扫 ----
const closed = await invoke("sandbox_close_session", { sessionId: sid });
check("close_session（silent）→ true", closed.out?.ok === true && closed.out?.result === true);
await new Promise((r) => setTimeout(r, 500)); // docker rm 落地后再看 ps
const residue = await dockerCli(["ps", "-aq", "--filter", "label=pianist-sandbox=1"]);
check("close_session 后 docker ps 查无残留", residue.code === 0 && residue.stdout.trim() === "");
shellProc.kill();

// ---- 10) auto 模式：red 直通 + 审计有痕 ----
const autoPort = 41894;
const autoProc = spawnShell(autoPort, { PIANIST_APPROVAL_MODE: "auto" });
await new Promise((r) => setTimeout(r, 800));
const autoOut = await (await fetch(`http://127.0.0.1:${autoPort}/tools/invoke`, {
	method: "POST", headers: { "content-type": "application/json" },
	body: JSON.stringify({ action: "sandbox_execute", agent: "pianist-dev-1", intent: "auto 档红命令直通", payload: { command: "rm -rf /tmp/auto-data && echo cleaned", deployment: { engine: "container", image: IMAGE } } }),
})).json();
check("auto 红区直通（一次性容器真跑了）", autoOut?.ok === true && autoOut?.result?.stdout?.trim() === "cleaned");
const audit = fs.existsSync(path.join(tmpDir, "audit.jsonl"))
	? fs.readFileSync(path.join(tmpDir, "audit.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
	: [];
check("auto 审计有痕（by=auto:auto）", audit.some((a) => a.by === "auto:auto" && a.action === "sandbox_execute"));
check("deny 审计有痕", audit.some((a) => a.approve === false && a.by === "tester"));
autoProc.kill();

const residueFinal = await dockerCli(["ps", "-aq", "--filter", "label=pianist-sandbox=1"]);
check("全场收尾 docker ps 查无残留", residueFinal.stdout.trim() === "");

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
