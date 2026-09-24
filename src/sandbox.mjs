/**
 * sandbox.mjs — 沙箱初版（施工⑤第一铲，2026-09-26）
 *
 * 契约面：SWE-ReX 形状的 SandboxManager，抄接口不装本体。8 方法：
 *   会话三件套 createSession / runInSession / closeSession
 *   一次性     execute
 *   文件       readFile / writeFile / upload
 *   生命周期   isAlive / close（全清所有会话与容器）
 *
 * 契约四魂（2026-09-19 定案：一份契约 + 两档引擎 + 零凭证铁律）：
 *   1. 异常穿透：错误序列化带类路径（error.__type，形如 sandbox.CommandFailureError），
 *      JSON 可序列化；调用端 reviveError 能重 raise 出真实类型（serializeError/reviveError 导出，
 *      供下一铲壳层 /sandbox 路由过 HTTP 边界时用）。
 *   2. X-Request-ID 幂等重试：同 ID 重发不重复执行——防「命令执行了但响应丢了」的重放。
 *      无 ID 的调用原样执行（幂等面按需启用）；在途同 ID 重发并入同一执行。
 *   3. DeploymentConfig 判别联合：{ engine: "container" | "microvm", ...options }，
 *      纯数据可 JSON 序列化，换引擎不改调用方代码。microvm 本铲只留判别位，
 *      实现处 throw（不装任何外部依赖）。
 *   4. 会话活在 manager 进程内：命令是 manager 持有的 docker exec 子进程，与调用端连接无关——
 *      断线后命令照跑完，重连（同 X-Request-ID 重发）能取回结果。
 *
 * 容器档（本铲唯一实现的档）：一会话 = 一加固 docker 容器，加固清单逐条落地：
 *   --cap-drop ALL · --security-opt no-new-privileges · 非 root（uid 对齐宿主当前用户）
 *   · --memory 512m --cpus 1 --pids-limit 256 · 无端口映射（严禁任何 0.0.0.0 绑定——
 *   本档从构造上就不传任何 -p/--publish，不是注释性约定）· --label pianist-sandbox=1（owner 标签，
 *   清扫残留用）· 会话关闭即 docker rm -f 清扫。
 *
 * 零凭证铁律：沙箱内不注入任何凭证。manager 永不把宿主 process.env 透传进容器——
 * env 只接受调用方显式给的字段；key 只活在宿主。
 *
 * 依赖：docker CLI（29.x 实证）。零 npm 依赖。
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";

// ---------------------------------------------------------------------------
// 错误分类（异常穿透的类型面）
// ---------------------------------------------------------------------------

/** 沙箱错误基类：toJSON 保证 JSON.stringify(err) 天然带 __type 类路径 */
export class SandboxError extends Error {
	constructor(message) {
		super(message);
		this.name = new.target.name; // 子类名穿透（默认 Error.name 会让类型不可辨）
	}
	toJSON() {
		return serializeError(this);
	}
}

/** 会话创建失败（docker run 层面失败：镜像缺失/守护进程拒绝等） */
export class SessionCreationError extends SandboxError {}

/** 会话不存在或已关闭 */
export class SessionNotFoundError extends SandboxError {}

/** 命令执行失败（非零退出码）。带 exitCode/stdout/stderr/command 细节 */
export class CommandFailureError extends SandboxError {
	constructor(message, details = {}) {
		super(message);
		this.command = details.command ?? null;
		this.exitCode = details.exitCode ?? null;
		// 输出细节截断：错误对象要跨边界序列化，别把 1MB 输出塞进异常路径
		this.stdout = typeof details.stdout === "string" ? details.stdout.slice(0, 16_384) : "";
		this.stderr = typeof details.stderr === "string" ? details.stderr.slice(0, 16_384) : "";
	}
}

/** 命令超时 */
export class CommandTimeoutError extends SandboxError {
	constructor(message, details = {}) {
		super(message);
		this.command = details.command ?? null;
		this.timeoutMs = details.timeoutMs ?? null;
	}
}

/** readFile 目标不存在 */
export class FileNotFoundError extends SandboxError {}

/** writeFile/upload 写入失败 */
export class FileWriteError extends SandboxError {}

/** 本模块错误类册子：revive 按类路径尾段查这里 */
const SANDBOX_ERRORS = {
	SandboxError,
	SessionCreationError,
	SessionNotFoundError,
	CommandFailureError,
	CommandTimeoutError,
	FileNotFoundError,
	FileWriteError,
};

/** 错误 → 纯 JSON 对象（带 __type 类路径；只带可序列化的原始值细节 + 截断 stack） */
export function serializeError(err) {
	if (err == null) return { __type: "sandbox.NullishError", message: String(err) };
	if (typeof err !== "object") return { __type: typeof err, message: String(err) };
	const out = {
		__type: typeof err.name === "string" && err.name ? `sandbox.${err.name}` : "sandbox.SandboxError",
		message: String(err?.message ?? err),
	};
	for (const [k, v] of Object.entries(err)) {
		if (k === "name" || k === "message" || k === "stack" || k === "__type") continue;
		if (v === null || ["string", "number", "boolean"].includes(typeof v)) out[k] = v;
		// 其余类型（对象/函数/符号）不带——序列化面只承诺原始值
	}
	if (typeof err.stack === "string") out.stack = err.stack.slice(0, 2_000);
	return out;
}

/**
 * 纯 JSON 对象 → 可重 raise 的真实错误类型。
 * sandbox.* 走本模块类册子；内建错误名（TypeError 等）按原型重建；
 * 认不出的类路径退回 Error 但保留 __type 原值——不静默改史。
 */
export function reviveError(obj) {
	if (!obj || typeof obj !== "object" || typeof obj.message !== "string") {
		// 出声纪律：还原不了要喊出来，不吞成 undefined
		return new SandboxError(`reviveError：形状不合法的错误对象（${JSON.stringify(obj)?.slice(0, 200)}）`);
	}
	const { __type, message, stack, ...rest } = obj;
	let err;
	if (typeof __type === "string" && __type.startsWith("sandbox.")) {
		const Ctor = SANDBOX_ERRORS[__type.slice("sandbox.".length)];
		err = Ctor ? new Ctor(message) : new SandboxError(message);
	} else if (typeof __type === "string" && typeof globalThis[__type] === "function"
		&& globalThis[__type].prototype instanceof Error) {
		// 内建类型（TypeError/RangeError…）——类路径直接可查，重 raise 真类型
		try {
			err = new globalThis[__type](message);
		} catch {
			err = new Error(message); // 构造签名特殊的内建类兜底
		}
	} else {
		err = new Error(message);
	}
	for (const [k, v] of Object.entries(rest)) err[k] = v;
	if (typeof __type === "string") err.__type = __type;
	if (typeof stack === "string") err.stack = stack; // 跨边界保留现场
	return err;
}

// ---------------------------------------------------------------------------
// DeploymentConfig（判别联合）
// ---------------------------------------------------------------------------

const DEFAULT_IMAGE = "alpine:latest";
const DEFAULT_WORKDIR = "/tmp"; // 非 root 可写（1777），alpine 无需预建

/**
 * 判别联合校验：{ engine: "container", image?, workdir? } | { engine: "microvm", ... }。
 * 纯数据、可 JSON 序列化；未知字段当场拒绝（契约面宁窄勿糊）。
 * microvm 是本铲的占位判别位——定案字面：throw new Error("microvm engine: not implemented in this iteration")
 */
export function validateDeployment(config) {
	const cfg = config ?? { engine: "container" };
	if (typeof cfg !== "object" || Array.isArray(cfg) || typeof cfg.engine !== "string") {
		throw new SandboxError(`DeploymentConfig 需为 { engine: "container"|"microvm", ... }，收到：${JSON.stringify(cfg)?.slice(0, 120)}`);
	}
	if (cfg.engine === "microvm") {
		throw new Error("microvm engine: not implemented in this iteration");
	}
	if (cfg.engine !== "container") {
		throw new SandboxError(`未知引擎 engine=${JSON.stringify(cfg.engine)}（本版仅 "container"，"microvm" 为占位判别位）`);
	}
	const { engine, image, workdir, ...unknown } = cfg;
	const bad = Object.keys(unknown);
	if (bad.length) throw new SandboxError(`DeploymentConfig 容器档未知字段：${bad.join(", ")}（只认 engine/image/workdir）`);
	if (image !== undefined && (typeof image !== "string" || !image)) throw new SandboxError("DeploymentConfig.image 需为非空字符串");
	if (workdir !== undefined && (typeof workdir !== "string" || !workdir.startsWith("/"))) throw new SandboxError("DeploymentConfig.workdir 需为绝对路径字符串");
	return { engine: "container", image: image ?? DEFAULT_IMAGE, workdir: workdir ?? DEFAULT_WORKDIR };
}

// ---------------------------------------------------------------------------
// docker CLI 包装（零依赖：spawn docker，数组参数，不走 shell——无注入面）
// ---------------------------------------------------------------------------

const DOCKER_OP_TIMEOUT_MS = 30_000; // run/rm/inspect 级操作
const MAX_CAPTURE = 1 << 20; // stdout/stderr 各 1MB 上限（防一堵大输出把 manager 内存打爆）

/**
 * 跑一条 docker 命令。返回 { code, stdout, stderr, killed }——不抛非零退出码
 * （退出码是业务信号，由调用方判读）；只在 CLI 本身不可用时 reject。
 * 输出超上限截断且必须出声（暗区检测器不制造暗区）。
 */
function docker(args, { stdin = null, timeoutMs = DOCKER_OP_TIMEOUT_MS, label = "docker" } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
		const out = [];
		const err = [];
		let outLen = 0;
		let errLen = 0;
		let outTrunc = false;
		let errTrunc = false;
		let killed = false;
		const timer = setTimeout(() => {
			killed = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.on("data", (c) => {
			if (outLen >= MAX_CAPTURE) { outTrunc = true; return; }
			out.push(c);
			outLen += c.length;
		});
		child.stderr.on("data", (c) => {
			if (errLen >= MAX_CAPTURE) { errTrunc = true; return; }
			err.push(c);
			errLen += c.length;
		});
		if (stdin !== null) child.stdin.end(stdin);
		else child.stdin.end();
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(new SandboxError(`docker CLI 不可用（PATH 无 docker？）：${e.message}`));
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (outTrunc || errTrunc) {
				console.warn(`[sandbox] ${label} 输出超 ${MAX_CAPTURE}B 上限已截断（stdout=${outTrunc} stderr=${errTrunc}）`);
			}
			resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), killed });
		});
	});
}

/** 输出 → 行数组（去尾换行；空串 → 空数组） */
function splitLines(s) {
	if (s === "") return [];
	return s.replace(/\n$/, "").split("\n");
}

// ---------------------------------------------------------------------------
// X-Request-ID 幂等缓存（契约四魂之二）
// ---------------------------------------------------------------------------

const IDEMPOTENCY_CAP = 256; // FIFO 容量：进程内记忆体面（重放窗口），够下一铲壳层用

/**
 * 同 ID = 同一次执行：
 *   - 在途重发 → 并入同一 promise（不重复起进程）
 *   - 已完成重发 → 原样回放缓存结果
 *   - 已失败重发 → 从序列化形态 revive 出真实类型重抛（跨边界语义与在途一致）
 * 缓存持强引用——这正是「会话活在 manager 进程内」的落点：调用端断线不失忆（契约四魂之四）。
 * 无 ID 调用绕过缓存原样执行。
 */
class RequestCache {
	constructor(cap = IDEMPOTENCY_CAP) {
		this.cap = cap;
		this.entries = new Map(); // requestId → { promise, state, payload }
	}

	run(key, fn) {
		if (key == null) return Promise.resolve().then(fn);
		const hit = this.entries.get(key);
		if (hit) {
			if (hit.state === "error") return Promise.reject(reviveError(hit.payload));
			return hit.promise;
		}
		const entry = { state: "running", promise: null, payload: null };
		entry.promise = Promise.resolve()
			.then(fn)
			.then(
				(value) => {
					entry.state = "done";
					return value;
				},
				(err) => {
					entry.state = "error";
					entry.payload = serializeError(err); // 缓存序列化形态：与跨进程重放的语义一致
					throw err;
				},
			);
		this.entries.set(key, entry);
		if (this.entries.size > this.cap) {
			this.entries.delete(this.entries.keys().next().value); // Map 插入序 FIFO
		}
		return entry.promise;
	}
}

// ---------------------------------------------------------------------------
// SandboxManager
// ---------------------------------------------------------------------------

// 非 root 铁律优先于 uid 对齐：宿主自身就是 root（uid 0）时，字面对齐会造出 root 容器——
// 落回固定非特权 1000。宿主为普通用户时严格对齐（容器内写出的文件归属宿主用户）。
// TODO: 多用户宿主 / microvm 档需要严格对齐时，把 runAsUid 提为 DeploymentConfig 字段（本铲不扩面）
const HOST_UID = typeof process.getuid === "function" ? process.getuid() : 0;
const HOST_GID = typeof process.getgid === "function" ? process.getgid() : 0;
const RUN_AS = HOST_UID === 0 ? "1000:1000" : `${HOST_UID}:${HOST_GID}`;

const OWNER_LABEL = "pianist-sandbox=1";
const DEFAULT_CMD_TIMEOUT_MS = 120_000;

export class SandboxManager {
	constructor() {
		this.sessions = new Map(); // sessionId → { sessionId, containerId, containerName, deployment, createdAt, lastUsedAt }
		this.requests = new RequestCache();
	}

	// ---- 会话三件套 ----

	/**
	 * 建会话（容器档：起一个加固容器挂住）。返回 sessionId。
	 * opts.requestId：同 ID 重发返回同一会话（不重复起容器）。
	 */
	createSession(deployment, opts = {}) {
		const dep = validateDeployment(deployment); // microvm 占位判别位在此 throw（定案字面）
		return this.requests.run(opts.requestId, () => this._createContainerSession(dep));
	}

	/**
	 * 会话内跑命令（sh -c 全 shell 语义）。成功返回 CommandResult：
	 *   { exitCode:0, stdout, stderr, stdoutLines, stderrLines, durationMs }
	 * 非零退出抛 CommandFailureError；超时抛 CommandTimeoutError。
	 * opts: { requestId?, timeoutMs?, cwd?, env? }
	 * env 只接受显式字段——manager 永不透传宿主 process.env（零凭证铁律）。
	 */
	runInSession(sessionId, command, opts = {}) {
		return this.requests.run(opts.requestId, () => this._exec(sessionId, command, opts));
	}

	/** 关会话：docker rm -f 清扫容器。幂等（已关/未知 → false，不重复 rm） */
	async closeSession(sessionId) {
		const s = this.sessions.get(sessionId);
		if (!s) return false;
		this.sessions.delete(sessionId);
		const r = await docker(["rm", "-f", s.containerId], { label: `closeSession(${sessionId})` });
		if (r.code !== 0) {
			// 清扫失败不静默：记录回滚保留，可重试——残留容器比丢会话记录更糟
			this.sessions.set(sessionId, s);
			throw new SandboxError(`会话 ${sessionId} 容器清扫失败（docker rm -f 退出码 ${r.code}）：${r.stderr.trim().slice(0, 200)}`);
		}
		return true;
	}

	// ---- 一次性 ----

	/**
	 * 一次性执行：临时会话 → 跑 → 关。opts: { deployment?, requestId?, timeoutMs?, cwd?, env? }
	 * 带 requestId 时全程幂等（含会话创建与清扫——重发不重复起容器、不重复执行）。
	 */
	execute(command, opts = {}) {
		const dep = validateDeployment(opts.deployment);
		return this.requests.run(opts.requestId, async () => {
			const sessionId = await this._createContainerSession(dep);
			try {
				return await this._exec(sessionId, command, opts);
			} finally {
				// 清扫失败在此抛出会盖掉命令结果——保留这个语义：容器残留比结果丢失更不可接受
				await this.closeSession(sessionId);
			}
		});
	}

	// ---- 文件 ----

	/** 读文件（文本面：utf8。二进制读档 TODO——本版契约用不到，不扩面） */
	readFile(sessionId, filePath, opts = {}) {
		return this.requests.run(opts.requestId, async () => {
			const s = this._requireSession(sessionId);
			const r = await docker(["exec", s.containerId, "cat", filePath], { label: `readFile(${filePath})` });
			if (r.code === 0) return r.stdout;
			if (/no such file/i.test(r.stderr)) throw new FileNotFoundError(`文件不存在：${filePath}`);
			throw new SandboxError(`readFile 失败（退出码 ${r.code}）：${filePath} ${r.stderr.trim().slice(0, 200)}`);
		});
	}

	/** 写文件（内容走 stdin 管道，无引号注入面；父目录自动创建）。返回 { path, bytes } */
	writeFile(sessionId, filePath, content, opts = {}) {
		return this.requests.run(opts.requestId, async () => {
			const s = this._requireSession(sessionId);
			if (typeof content !== "string" && !Buffer.isBuffer(content)) {
				throw new SandboxError("writeFile content 需为 string | Buffer");
			}
			// sh -c 脚本 + 位置参数传路径（路径不进命令串）；内容经 stdin 直灌 cat
			const r = await docker(
				["exec", "-i", s.containerId, "sh", "-c", 'mkdir -p "$(dirname "$1")" && cat > "$1"', "pianist", filePath],
				{ stdin: content, label: `writeFile(${filePath})` },
			);
			if (r.code !== 0) throw new FileWriteError(`writeFile 失败（退出码 ${r.code}）：${filePath} ${r.stderr.trim().slice(0, 200)}`);
			return { path: filePath, bytes: Buffer.byteLength(content) };
		});
	}

	/**
	 * 批量上传：files: [{ path, content } | { path, localPath }]。
	 * content 直写；localPath 从宿主读文件内容再写（读的是调用方显式声明的路径，
	 * 不是 manager 自作主张搬运宿主任何东西——零凭证铁律同源）。返回 { path: bytes }
	 */
	upload(sessionId, files, opts = {}) {
		return this.requests.run(opts.requestId, async () => {
			if (!Array.isArray(files) || files.length === 0) throw new SandboxError("upload 需要非空 files 数组");
			const out = {};
			for (const f of files) {
				const dest = f?.path;
				if (typeof dest !== "string" || !dest.startsWith("/")) {
					throw new SandboxError(`upload 条目缺沙箱内绝对路径 path：${JSON.stringify(f)?.slice(0, 120)}`);
				}
				let content;
				if (typeof f.content === "string" || Buffer.isBuffer(f.content)) {
					content = f.content;
				} else if (typeof f.localPath === "string") {
					try {
						content = await fs.readFile(f.localPath); // TODO: 大文件流式上传（本版测试面 KB 级）
					} catch (e) {
						throw new FileWriteError(`upload 读宿主文件失败 ${f.localPath}：${e.message}`);
					}
				} else {
					throw new SandboxError(`upload 条目 ${dest} 需有 content 或 localPath`);
				}
				const w = await this.writeFile(sessionId, dest, content);
				out[dest] = w.bytes;
			}
			return out;
		});
	}

	// ---- 生命周期 ----

	/** 会话还活着吗（探针语义：未知/已关 → false，不抛）。无副作用，不进幂等缓存 */
	async isAlive(sessionId) {
		const s = this.sessions.get(sessionId);
		if (!s) return false;
		const r = await docker(["inspect", "-f", "{{.State.Running}}", s.containerId], { timeoutMs: 10_000, label: `isAlive(${sessionId})` });
		return r.code === 0 && r.stdout.trim() === "true";
	}

	/**
	 * 全清：关掉本 manager 全部会话，再按 owner 标签清扫残留（上次崩溃留下的孤儿容器）。
	 * TODO: 多实例共用一台 docker 时标签清扫会误伤邻居——初版按单实例假设执行。
	 */
	async close() {
		const failures = [];
		for (const id of [...this.sessions.keys()]) {
			try {
				await this.closeSession(id);
			} catch (e) {
				failures.push(`会话 ${id}：${e.message}`);
			}
		}
		const leftover = await docker(["ps", "-aq", "--filter", `label=${OWNER_LABEL}`], { label: "close() 清扫" });
		if (leftover.code !== 0) {
			throw new SandboxError(`close() 残留清扫失败（docker ps 退出码 ${leftover.code}）：${leftover.stderr.trim().slice(0, 200)}`);
		}
		const ids = leftover.stdout.trim().split("\n").filter(Boolean);
		if (ids.length) {
			const r = await docker(["rm", "-f", ...ids], { label: "close() 清扫" });
			if (r.code !== 0) failures.push(`标签清扫：${r.stderr.trim().slice(0, 200)}`);
		}
		if (failures.length) throw new SandboxError(`close() 部分失败——${failures.join("；").slice(0, 500)}`);
	}

	// ---- 内部 ----

	_requireSession(sessionId) {
		const s = this.sessions.get(sessionId);
		if (!s) throw new SessionNotFoundError(`会话不存在或已关闭：${sessionId}`);
		return s;
	}

	/** 建容器会话的无幂等层（createSession/execute 复用，幂等由外层统一持） */
	async _createContainerSession(dep) {
		const sessionId = `sbx_${Date.now().toString(36)}_${randomBytes(4).toString("hex")}`;
		const containerName = `pianist-sbx-${sessionId}`; // 会话名可寻址（inspect/排障），ownerId 走 label
		const args = [
			"run", "-d",
			"--name", containerName,
			"--label", OWNER_LABEL, // owner 标签：清扫残留用
			"--cap-drop", "ALL", // 能力清零
			"--security-opt", "no-new-privileges", // 禁提权
			"--user", RUN_AS, // 非 root（uid 对齐宿主；宿主为 root 时落 1000，见上）
			"--memory", "512m",
			"--cpus", "1",
			"--pids-limit", "256", // 三上限
			// 端口：本档不传任何 -p/--publish——0.0.0.0 绑定从构造上不存在
			"-w", dep.workdir,
			dep.image,
			"sleep", "infinity", // 挂住容器等 exec（alpine busybox 实证支持）
		];
		const r = await docker(args, { label: `createSession(${sessionId})` });
		if (r.code !== 0) {
			throw new SessionCreationError(`会话创建失败（docker run ${dep.image} 退出码 ${r.code}）：${r.stderr.trim().slice(0, 300)}`);
		}
		this.sessions.set(sessionId, {
			sessionId,
			containerId: r.stdout.trim(),
			containerName,
			deployment: dep,
			createdAt: new Date().toISOString(),
			lastUsedAt: new Date().toISOString(),
		});
		return sessionId;
	}

	/** exec 的无幂等层 */
	async _exec(sessionId, command, opts) {
		const s = this._requireSession(sessionId);
		if (typeof command !== "string" || !command.trim()) throw new SandboxError("runInSession command 需为非空字符串");
		s.lastUsedAt = new Date().toISOString();
		const execArgs = ["exec"];
		if (opts.cwd) execArgs.push("-w", opts.cwd);
		for (const [k, v] of Object.entries(opts.env ?? {})) execArgs.push("-e", `${k}=${v}`);
		execArgs.push(s.containerId, "sh", "-c", command);
		const timeoutMs = opts.timeoutMs ?? DEFAULT_CMD_TIMEOUT_MS;
		const started = Date.now();
		const r = await docker(execArgs, { timeoutMs: timeoutMs + 5_000, label: `runInSession(${command.slice(0, 60)})` });
		const durationMs = Date.now() - started;
		if (r.killed) {
			// 杀掉的是 docker CLI 客户端；容器内孤儿进程的追杀 TODO（下一铲：exec 前 pgid 包裹）。
			// 本版超时即报错，不谎报结果。
			throw new CommandTimeoutError(`命令超时（>${timeoutMs}ms）：${command.slice(0, 120)}`, { command, timeoutMs });
		}
		const result = {
			exitCode: r.code,
			stdout: r.stdout,
			stderr: r.stderr,
			stdoutLines: splitLines(r.stdout),
			stderrLines: splitLines(r.stderr),
			durationMs,
		};
		if (r.code !== 0) {
			throw new CommandFailureError(`命令失败（退出码 ${r.code}）：${command.slice(0, 200)}`, { command, ...result });
		}
		return result;
	}
}
