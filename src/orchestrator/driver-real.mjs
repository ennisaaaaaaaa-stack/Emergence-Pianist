/**
 * driver-real.mjs — RealDriver 真身驱动器（任务编排器⑧ 第一铲·真身接线）
 *
 * 是什么：OrchestratorEngine 构造器注释里的注入驱动器接口 { spawn/sendReport/sigterm/
 * sigkill/isAlive } 的真实现——真分身进程的生死信号面。orch-v0 八件套的假驱动器到此退役。
 * 钉子全部照抄 conductor.mjs launchPart（约 L520-570，2026-09-25 尸检定案）：
 *   ① pi 入口：piBin 以 .mjs/.js 结尾直接当入口用（测试 stub 走这个）；否则解析到
 *      node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js——不用 .bin/pi 的
 *      shebang（/usr/bin/env node 会拿错 PATH 里的 node）。
 *   ② spawn 一律 process.execPath 起进程——爹用哪个 node 儿子就用哪个，版本错位结构性
 *      排除（19连抽事故钉了爹漏了儿子，这次钉儿子）。
 *   ③ 钥匙供给 envOrVault("ZAI_CODING_CN_API_KEY", "coding-plan", `orch:${taskId}/${minionId}`)
 *      ——T16 context 透传，账本记到任务级粒度（拍板表#3）。
 *   ④ PIANIST_SHELL_URL（缺省 8770）+ no_proxy=127.0.0.1,localhost（壳地址不许走环境代理）。
 *
 * 沙箱映射（拍板表#6）：tier=null 直接 spawn；tier 有值走 runSandboxed 包 pi 命令。
 * 沙箱路径的诚实降级（v0 写明不装）：runSandboxed 不暴露子 pid（detached launcher 整组
 * 收割是执行器内部事），引擎信号打不到沙箱内进程——硬停靠 executor timeoutMs 兜底，
 * isAlive 靠 runSandboxed 结算 Promise；sigterm/sigkill 记 killDegraded 出声，不假装发了信号。
 *
 * sendReport（拍板表#5）= 写遗言提示文件 progressDir/<minionId>.md（一行提示「转报告模式，
 * 把当前进度和阻塞点写进本文件」）。pi -p 无 stdin，进程不中断——这是诚实降级不是假装发了信号。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { envOrVault } from "../../credentials/env-source.mjs";
import { runSandboxed as defaultRunSandboxed } from "../../sandbox/executor.mjs";
import { resolveSandboxTier } from "./sandbox-tiers.mjs";
import { buildMinionPrompt } from "./prompt-builder.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

export class RealDriver {
	/**
	 * @param {object} opts
	 * @param {string} [opts.cwd]            spawn 工作目录（指针解析基目录）
	 * @param {string|null} [opts.piBin]     pi 入口（.mjs/.js 直接当入口=测试 stub 位）；缺省 ORCH_PI_BIN env → 默认 bundle
	 * @param {string} [opts.model]          模型（conductor 同款缺省）
	 * @param {string} [opts.shellUrl]       壳地址（缺省 PIANIST_SHELL_URL env → 127.0.0.1:8770）
	 * @param {string} [opts.progressDir]    遗言/进度目录（缺省 ORCH_PROGRESS_DIR env → /tmp/orch-progress）
	 * @param {Function} [opts.runSandboxed] 沙箱执行器（注入位：测试记调用，不真起沙箱）
	 * @param {Function} [opts.buildPrompt]  prompt 构造器（缺省 buildMinionPrompt + 绑定 sheet 角色）
	 * @param {object|null} [opts.sheet]     绑定任务书（引擎重试 spawn 的 cfg 不带沙箱列/指针，按角色回查）
	 * @param {number|null} [opts.hardStopMs] 沙箱路径 executor 级硬停兜底（无总时钟则不设）
	 * @param {(minionId: string, spawnRec: object) => void} [opts.onSpawn] spawn 后回调（runtime 接 watcher）
	 * @param {(minionId: string, exit: {code:number|null, signal:string|null, tail:string}) => void} [opts.onExit] 退场回调（runtime 收尾泵）
	 */
	constructor({
		cwd = process.cwd(),
		piBin = null,
		model = "zai-coding-cn/glm-5.2",
		shellUrl = process.env.PIANIST_SHELL_URL ?? "http://127.0.0.1:8770",
		progressDir = process.env.ORCH_PROGRESS_DIR ?? "/tmp/orch-progress",
		runSandboxed = defaultRunSandboxed,
		buildPrompt = null,
		sheet = null,
		hardStopMs = null,
		onSpawn = null,
		onExit = null,
		now = Date.now,
	} = {}) {
		this.cwd = cwd;
		this.piBinOpt = piBin;
		this.model = model;
		this.shellUrl = shellUrl;
		this.progressDir = progressDir;
		this.runSandboxed = runSandboxed;
		this.buildPromptOpt = buildPrompt;
		this.sheet = sheet;
		this.roleEntries = new Map((sheet?.roles ?? []).map((r) => [r.role, r]));
		this.hardStopMs = hardStopMs;
		this.onSpawn = onSpawn;
		this.onExit = onExit;
		this.now = now;
		this.rows = new Map(); // minionId → spawn 记录（pid/entry/sandboxed/tier/prompt/done/tail）
		fs.mkdirSync(this.progressDir, { recursive: true });
	}

	/** pi 入口解析（conductor 钉子①照抄；ORCH_PI_BIN=测试 stub 位，拍板表#9） */
	resolvePiEntry() {
		const piBin = this.piBinOpt ?? process.env.ORCH_PI_BIN ?? null;
		if (piBin && (piBin.endsWith(".mjs") || piBin.endsWith(".js"))) return path.resolve(this.cwd, piBin);
		if (piBin) return path.resolve(this.cwd, piBin);
		return path.join(REPO_ROOT, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
	}

	agentIdFor(minionId) {
		return `orch-${minionId}`;
	}

	/** 按角色回查任务书沙箱列（引擎重试 spawn 的 cfg 不带，角色是稳定键） */
	_roleEntry(role) {
		return this.roleEntries.get(role) ?? null;
	}

	/**
	 * 真拉起一个分身。同步返回 spawn 记录（引擎重试路径是同步调用）；
	 * 进程退场经 onExit 回调出（收尾泵在 runtime，引擎逻辑不动）。
	 * @param {object} cfg { taskId, minionId, role, sheetId, sandbox?, pointer?, prompt?, workaround?, failureReason? }
	 */
	spawn(cfg) {
		const { taskId, minionId, role } = cfg;
		if (!minionId || !role) throw new Error(`RealDriver.spawn 需要 taskId/minionId/role（got taskId=${taskId} minionId=${minionId} role=${role}）`);
		if (this.rows.has(minionId)) throw new Error(`RealDriver 重复 minionId：${minionId}（台账按进程记，id 即身份）`);

		// prompt：cfg 显式给（runtime 首发）→ 否则按角色构造（引擎重试 cfg 走这条）
		const roleEntry = this._roleEntry(role);
		let prompt = cfg.prompt ?? null;
		if (prompt == null) {
			const builder = this.buildPromptOpt ?? ((c) => buildMinionPrompt({
				sheet: this.sheet, roleEntry: this._roleEntry(c.role), taskId: c.taskId, minionId: c.minionId,
				workaround: c.workaround ?? null, failureReason: c.failureReason ?? null, cwd: this.cwd,
			}));
			prompt = builder(cfg);
		}
		// 沙箱档位：cfg.sandbox 显式（首发带角色表列值）→ 角色默认表
		const sandboxCol = cfg.sandbox ?? roleEntry?.sandbox ?? null;
		const tier = resolveSandboxTier({ role, sandbox: sandboxCol });

		// spawn env（conductor 钉子③④）
		const env = {
			...process.env,
			PIANIST_AGENT_ID: this.agentIdFor(minionId),
			PIANIST_SHELL_URL: this.shellUrl,
			NO_COLOR: "1",
			no_proxy: "127.0.0.1,localhost",
			NO_PROXY: "127.0.0.1,localhost",
			ZAI_CODING_CN_API_KEY: envOrVault("ZAI_CODING_CN_API_KEY", "coding-plan", `orch:${taskId}/${minionId}`),
		};

		const rec = {
			minionId, taskId, role, sheetId: cfg.sheetId ?? null,
			prompt, tier: tier.tier, policyPath: tier.policyPath, enforcement: tier.enforcement, tierBasis: tier.basis,
			agentId: this.agentIdFor(minionId),
			entry: this.resolvePiEntry(),
			pid: null, sandboxed: tier.tier != null,
			spawnAt: this.now(),
			done: false, exit: null, tail: "",
			killDegraded: null,
			closed: null, // Promise（退场结算；测试 await 用）
		};
		this.rows.set(minionId, rec);

		// argv 与 conductor 同款：pi -p --model <model> <TASK>
		const piArgv = ["-p", "--model", this.model, prompt];
		if (rec.sandboxed) {
			// tier 有值 → runSandboxed 包 pi 命令（拍板表#6）；注入位让测试记调用不真起沙箱
			const sandboxEnv = {
				PIANIST_AGENT_ID: env.PIANIST_AGENT_ID,
				PIANIST_SHELL_URL: env.PIANIST_SHELL_URL,
				NO_COLOR: "1",
				ZAI_CODING_CN_API_KEY: env.ZAI_CODING_CN_API_KEY,
			};
			rec.pid = null; // 无 pid 可持（见文件头诚实降级注记）
			rec.closed = Promise.resolve()
				.then(() => this.runSandboxed({
					command: [process.execPath, rec.entry, ...piArgv],
					policyPath: tier.policyPath,
					agent: minionId,
					timeoutMs: this.hardStopMs ?? undefined,
					env: sandboxEnv,
				}))
				.then((res) => {
					rec.done = true;
					rec.exit = { code: res?.code ?? null, signal: res?.signal ?? null, tail: "" };
					this.onExit?.(minionId, rec.exit);
					return rec.exit;
				})
				.catch((err) => {
					rec.done = true;
					rec.exit = { code: -1, signal: null, tail: `runSandboxed 失败：${err?.message ?? err}` };
					this.onExit?.(minionId, rec.exit);
					return rec.exit;
				});
		} else {
			// tier=null → 直接 spawn（钉子②：process.execPath 起进程，版本错位结构性排除）
			const child = spawn(process.execPath, [rec.entry, ...piArgv], {
				cwd: this.cwd,
				env,
				stdio: ["ignore", "pipe", "pipe"],
			});
			rec.pid = child.pid ?? null;
			rec.child = child;
			let out = ""; let err = "";
			child.stdout?.on("data", (d) => { out += d.toString(); });
			child.stderr?.on("data", (d) => { err += d.toString(); });
			// ① pid 到手即入账（死时验尸少一跳）；② 信号死法随 close 带回（conductor 死法注记同款）
			rec.closed = new Promise((resolve) => {
				child.on("close", (code, signal) => {
					rec.done = true;
					rec.exit = { code, signal: signal ?? null, tail: (out + "\n" + err).slice(-500) };
					this.onExit?.(minionId, rec.exit);
					resolve(rec.exit);
				});
			});
			child.on("error", (e) => {
				rec.done = true;
				rec.exit = { code: -1, signal: null, tail: `spawn error：${e?.message ?? e}` };
				this.onExit?.(minionId, rec.exit);
			});
		}
		this.onSpawn?.(minionId, { ...rec, closed: undefined });
		return { ...rec, closed: undefined };
	}

	/**
	 * 转报告模式（拍板表#5）：写遗言提示文件——pi -p 无 stdin，进程不中断，
	 * 分身看到文件内容是下一次工具调用的事；这是诚实降级不是假装发了信号。
	 * 已存在不覆盖（分身可能已开写遗言，别踩它）。
	 * @returns {string} 遗言文件路径
	 */
	sendReport(minionId) {
		const file = path.join(this.progressDir, `${minionId}.md`);
		if (!fs.existsSync(file)) {
			fs.mkdirSync(this.progressDir, { recursive: true });
			fs.writeFileSync(
				file,
				`> [orch] 转报告模式：把当前进度和阻塞点写进本文件（遗言）。${new Date(this.now()).toISOString()}\n`,
			);
		}
		return file;
	}

	/** 真信号 SIGTERM（三级收尾第一级）。沙箱路径诚实降级：无 pid 可信号，记 killDegraded 出声。 */
	sigterm(minionId) {
		return this._signal(minionId, "SIGTERM");
	}

	sigkill(minionId) {
		return this._signal(minionId, "SIGKILL");
	}

	_signal(minionId, sig) {
		const rec = this.rows.get(minionId);
		if (!rec) return { sent: false, why: "未知分身" };
		if (rec.done) return { sent: false, why: "已退场" };
		if (rec.sandboxed) {
			rec.killDegraded = `${sig} 降级：沙箱路径无 pid 可信号——硬停靠 executor timeoutMs 兜底（v0 写明不装）`;
			return { sent: false, why: rec.killDegraded, degraded: true };
		}
		if (rec.pid == null) return { sent: false, why: "无 pid" };
		try {
			process.kill(rec.pid, sig);
			return { sent: true };
		} catch (err) {
			return { sent: false, why: `signal ${sig} 失败：${err?.code ?? err?.message}` };
		}
	}

	/**
	 * 探活：直 spawn=pid 探活（process.kill(pid,0)；ESRCH=死，EPERM=活着只是不归我们管）；
	 * 沙箱=runSandboxed 结算态。退场已观测（done）优先——防 pid 复用假阳。
	 */
	isAlive(minionId) {
		const rec = this.rows.get(minionId);
		if (!rec) return false;
		if (rec.done) return false;
		if (rec.sandboxed || rec.pid == null) return true; // 未结算即视为在飞（沙箱诚实面：结算 Promise 是唯一死讯源）
		try {
			process.kill(rec.pid, 0);
			return true;
		} catch (err) {
			if (err?.code === "ESRCH") return false;
			if (err?.code === "EPERM") return true;
			return false;
		}
	}

	get(minionId) {
		const rec = this.rows.get(minionId);
		return rec ? { ...rec, closed: undefined, child: undefined } : null;
	}
}
