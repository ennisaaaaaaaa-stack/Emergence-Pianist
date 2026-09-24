// 施工⑤第一铲测试：SandboxManager 容器档——真 docker、真加固、真异常（2026-09-26）
// 验证链：
//   0. 镜像自举：alpine:latest 缺则 pull，拉不动兜底 alpine:3.19（都不行才判阻塞）
//   1. 全链：createSession → runInSession("echo ok") → writeFile/readFile 往返 → isAlive
//      → closeSession → docker ps -a 查无残留
//   2. 加固断言（docker inspect）：cap-drop ALL 且零 cap-add、no-new-privileges、非 root、
//      内存 512m / 1 cpu / pids 256、零端口绑定、owner 标签
//   3. 异常穿透：exit 7 → CommandFailureError 带退出码；serializeError→JSON→reviveError
//      往返仍是真类型；未知会话 → SessionNotFoundError
//   4. 幂等（X-Request-ID）：同 ID 的 runInSession 重发不重复执行（计数文件只 +1）；
//      同 ID 的 execute 重发原样回放缓存结果（不同 ID 才真重跑）
//   5. 会话活在 manager 进程内：长命令发起后不等（模拟断线），重连同 ID 取回结果且只跑一次
//   6. microvm 判别位：按定案字面 throw "not implemented in this iteration"
// 遥测说明：测试起停容器走 docker CLI，不经壳——天然不进遥测，无需特殊处理。
// 运行：node --test test/sandbox-engine-test.mjs（本机需 docker；风格同库内其余直跑测试）

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	SandboxManager,
	CommandFailureError,
	SessionNotFoundError,
	serializeError,
	reviveError,
} from "../src/sandbox.mjs";

let pass = 0;
let total = 0;
function check(name, ok) {
	total++;
	if (ok) pass++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

/** 测试侧 docker CLI 直调（不经 manager——观测容器真实状态） */
function dockerCli(args, { stdin = null, timeoutMs = 60_000 } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
		const out = [];
		const err = [];
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
		child.stdout.on("data", (c) => out.push(c));
		child.stderr.on("data", (c) => err.push(c));
		if (stdin !== null) child.stdin.end(stdin);
		else child.stdin.end();
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(new Error(`docker CLI 不可用：${e.message}`));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
		});
	});
}

// ---- 0) 镜像自举 ----
async function ensureImage() {
	const has = await dockerCli(["image", "inspect", "alpine:latest"]);
	if (has.code === 0) return "alpine:latest";
	console.log("[sandbox-test] alpine:latest 缺失，先 docker pull（缺就拉，任务书字面）");
	const p1 = await dockerCli(["pull", "alpine:latest"], { timeoutMs: 180_000 });
	if (p1.code === 0) return "alpine:latest";
	console.warn(`[sandbox-test] alpine:latest 拉取失败，兜底 alpine:3.19：${p1.stderr.trim().slice(0, 120)}`);
	const p2 = await dockerCli(["pull", "alpine:3.19"], { timeoutMs: 180_000 });
	if (p2.code === 0) return "alpine:3.19";
	// 出声纪律：真容器测试没镜像就是硬阻塞，不装绿
	console.error(`[sandbox-test] alpine 镜像两条路都拉不动，真容器测试无法进行：${p2.stderr.trim().slice(0, 200)}`);
	process.exit(1);
}
const IMAGE = await ensureImage();
check(`镜像就绪（${IMAGE}）`, true);

// 开工前先扫残留（上一次跑挂了可能留下带 owner 标签的孤儿容器——先清再测，别把旧账记新账上）
const preSweep = await dockerCli(["ps", "-aq", "--filter", "label=pianist-sandbox=1"]);
if (preSweep.stdout.trim()) {
	console.warn(`[sandbox-test] 开工前清扫上次残留容器：${preSweep.stdout.trim().split("\n").join(" ").slice(0, 100)}`);
	await dockerCli(["rm", "-f", ...preSweep.stdout.trim().split("\n")]);
}

const mgr = new SandboxManager();

// ---- 1) 全链 ----
const sid = await mgr.createSession({ engine: "container", image: IMAGE });
check("createSession 返回会话 id", typeof sid === "string" && sid.startsWith("sbx_"));

const echo = await mgr.runInSession(sid, "echo ok");
check("runInSession echo ok（exitCode=0 stdout=ok）", echo.exitCode === 0 && echo.stdout.trim() === "ok");
check("结果带行数组", echo.stdoutLines.length === 1 && echo.stdoutLines[0] === "ok");

const CONTENT = "第一行\n第二行 \"引号\" $VAR `反引号` '单引号'\n"; // 引号/变量/反引号全上——验证 stdin 管道无注入面
const written = await mgr.writeFile(sid, "/tmp/pianist/dir/笔记.txt", CONTENT);
check("writeFile 返回字节数", written.bytes === Buffer.byteLength(CONTENT));
const readBack = await mgr.readFile(sid, "/tmp/pianist/dir/笔记.txt");
check("readFile 往返逐字节一致", readBack === CONTENT);

// upload：content 直写 + localPath 宿主文件两条路
const tmpHost = fs.mkdtempSync(path.join(os.tmpdir(), "pianist-sbx-upload-"));
fs.writeFileSync(path.join(tmpHost, "host.txt"), "from host 上传内容");
const up = await mgr.upload(sid, [
	{ path: "/tmp/up/a.txt", content: "直写内容" },
	{ path: "/tmp/up/host.txt", localPath: path.join(tmpHost, "host.txt") },
]);
check("upload 两种来源都到货", (await mgr.readFile(sid, "/tmp/up/a.txt")) === "直写内容"
	&& (await mgr.readFile(sid, "/tmp/up/host.txt")) === "from host 上传内容"
	&& up["/tmp/up/host.txt"] === Buffer.byteLength("from host 上传内容"));

check("isAlive true", (await mgr.isAlive(sid)) === true);
check("closeSession 返回 true", (await mgr.closeSession(sid)) === true);
check("closeSession 幂等（重复关 → false）", (await mgr.closeSession(sid)) === false);
check("关闭后 isAlive false", (await mgr.isAlive(sid)) === false);

const residue1 = await dockerCli(["ps", "-aq", "--filter", "label=pianist-sandbox=1"]);
check("closeSession 后 docker ps -a 查无残留", residue1.code === 0 && residue1.stdout.trim() === "");

// ---- 2) 加固断言 ----
const sid2 = await mgr.createSession({ engine: "container", image: IMAGE });
const cid = (await dockerCli(["ps", "-q", "--filter", `name=pianist-sbx-${sid2}`])).stdout.trim();
check("容器按会话名可寻址", /^[0-9a-f]{12,64}$/.test(cid)); // docker 29 的 ps -q 默认短 ID，inspect 全 ID 都接受
const cfg = JSON.parse((await dockerCli(["inspect", cid])).stdout)[0];

check("cap-drop ALL（能力清到空集）", (cfg.HostConfig.CapDrop ?? []).includes("ALL"));
check("无任何 cap-add", (cfg.HostConfig.CapAdd ?? []).length === 0);
check("no-new-privileges", (cfg.HostConfig.SecurityOpt ?? []).some((o) => o.startsWith("no-new-privileges")));
check(`非 root 运行（User=${cfg.Config.User}）`, cfg.Config.User !== "" && cfg.Config.User !== "0"
	&& cfg.Config.User !== "root" && !/^0:/.test(cfg.Config.User));
check("内存上限 512m", cfg.HostConfig.Memory === 536_870_912);
check("cpu 上限 1 核（NanoCpus=1e9）", cfg.HostConfig.NanoCpus === 1_000_000_000);
check("pids 上限 256", cfg.HostConfig.PidsLimit === 256);
const portCfg = cfg.HostConfig.PortBindings ?? {};
const livePorts = cfg.NetworkSettings?.Ports ?? {};
check("无端口映射（严禁 0.0.0.0 绑定）", Object.keys(portCfg).length === 0
	&& Object.values(livePorts).every((v) => v == null || v.length === 0));
check("owner 标签 pianist-sandbox=1", (cfg.Config.Labels ?? {})["pianist-sandbox"] === "1");

// ---- 3) 异常穿透 ----
let caught = null;
try {
	await mgr.runInSession(sid2, "echo before >&2; exit 7");
} catch (e) {
	caught = e;
}
check("exit 7 抛 CommandFailureError（真实类型）", caught instanceof CommandFailureError);
check("错误带退出码与输出细节", caught?.exitCode === 7 && caught?.stderr.includes("before"));

const wire = JSON.stringify(serializeError(caught)); // 序列化面：可过 JSON 边界
const revived = reviveError(JSON.parse(wire));
check("序列化带类路径 __type", typeof wire === "string" && wire.includes('"__type":"sandbox.CommandFailureError"'));
check("JSON 往返后仍是真实类型", revived instanceof CommandFailureError && revived.exitCode === 7 && revived.message === caught.message);

let nf = null;
try {
	await mgr.runInSession("sbx_不存在", "echo 1");
} catch (e) {
	nf = e;
}
check("未知会话抛 SessionNotFoundError", nf instanceof SessionNotFoundError);

// ---- 4) 幂等（X-Request-ID）----
// 4a. runInSession：同 ID 两次 → 容器内计数文件只有一行
await mgr.runInSession(sid2, "echo 1 >> /tmp/cnt", { requestId: "req-cnt-1" });
await mgr.runInSession(sid2, "echo 1 >> /tmp/cnt", { requestId: "req-cnt-1" });
const cnt = await mgr.runInSession(sid2, "wc -l < /tmp/cnt");
check("同 X-Request-ID 重发不重复执行（计数=1）", cnt.stdout.trim() === "1");

// 4b. execute：同 ID 重发原样回放缓存（uuid 逐字节一致）；不同 ID 才真重跑
const exe1 = await mgr.execute("cat /proc/sys/kernel/random/uuid", { requestId: "req-exe-1", deployment: { engine: "container", image: IMAGE } });
const exe2 = await mgr.execute("cat /proc/sys/kernel/random/uuid", { requestId: "req-exe-1", deployment: { engine: "container", image: IMAGE } });
check("execute 同 ID 重发回放缓存（结果逐字节一致）", exe1.stdout === exe2.stdout && exe1.durationMs === exe2.durationMs);
const exe3 = await mgr.execute("cat /proc/sys/kernel/random/uuid", { requestId: "req-exe-2", deployment: { engine: "container", image: IMAGE } });
check("execute 不同 ID 是真执行（uuid 不同）", exe3.stdout !== exe1.stdout);

// ---- 5) 会话活在 manager 进程内：断线后照跑完，重连取回结果 ----
// 模拟断线：发起慢命令但不等它（丢弃调用端句柄），随后立刻用同 X-Request-ID「重连」——
// 应并入同一次执行：命令照跑完、只跑一次、两次拿到同一结果
const dangling = mgr.runInSession(sid2, "sleep 1; echo 1 >> /tmp/cnt2; cat /proc/sys/kernel/random/uuid", { requestId: "req-drop-1" });
const rejoined = await mgr.runInSession(sid2, "（重发参数被幂等层忽略）", { requestId: "req-drop-1" });
const finished = await dangling;
check("重连同 ID 取回原执行结果", rejoined.stdout === finished.stdout && rejoined.durationMs === finished.durationMs);
const cnt2 = await mgr.runInSession(sid2, "wc -l < /tmp/cnt2");
check("断线后命令照跑完且只跑一次（计数=1）", cnt2.stdout.trim() === "1");

// ---- 6) microvm 占位判别位 ----
let mv = null;
try {
	await mgr.createSession({ engine: "microvm" });
} catch (e) {
	mv = e;
}
check("microvm 按定案字面 throw", mv?.message === "microvm engine: not implemented in this iteration");

// ---- 收尾：close() 全清 ----
await mgr.close();
const residue2 = await dockerCli(["ps", "-aq", "--filter", "label=pianist-sandbox=1"]);
check("close() 全清后查无残留", residue2.code === 0 && residue2.stdout.trim() === "");

fs.rmSync(tmpHost, { recursive: true, force: true });
console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
