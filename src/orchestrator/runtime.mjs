/**
 * runtime.mjs — 组合根（任务编排器⑧ 第一铲·真身接线；拍板表#1 → 第二铲·生命周期，拍板表⑧-2 #4/#5）
 *
 * 是什么：buildRuntime({ sheetText, piBin, ...opts }) 单入口，把 ledger/inbox/supervisor/
 * engine/RealDriver/HeartbeatWatcher/Watchman 组装成一个可发车的 runtime——不散装。
 * 链路：解析任务书 → launchMinion（真 spawn + 台账登记 + 心跳源接线）→ watcher 喂 beat →
 * 引擎双时钟监督 → 收尾泵（DONE 交货 / BLOCKED 转报 / 暴死讣告）入账进收件箱。
 * 第二铲加生命周期两件：看门人（watchman.sweep 三判喊「讣告候选」，只喊不定死，拍板#4）+
 * 常驻 tick（startLoop/stop：一个 interval 打包 poll→tick→sweep，拍板#5；不部署 systemd，
 * 接口先活部署随实战调）。conductor 接线等 watchman 形状定型后再做（本单不接）。
 * 分身审批上浮轮（the user 10/7 定案①拍板7）：pollApprovals 拉壳 /approvals/pending →
 * 收件箱 kind=审批（payload=卡片本体含机器行+白话行双行），同 id 只投一次；
 * 卡片裁决后 pending 消失不追投裁决结果（裁决面归人，v0 不回环）。
 * 分身审批上浮轮（the user 10/7 定案①拍板7）：pollApprovals 拉壳 /approvals/pending →
 * 收件箱 kind=审批（payload=卡片本体含机器行+白话行双行），同 id 只投一次；
 * 卡片裁决后 pending 消失不追投裁决结果（裁决面归人，v0 不回环）。
 * 分身审批上浮轮（the user 10/7 定案①拍板7）：pollApprovals 拉壳 /approvals/pending →
 * 收件箱 kind=审批（payload=卡片本体含机器行+白话行双行），同 id 只投一次；
 * 卡片裁决后 pending 消失不追投裁决结果（裁决面归人，v0 不回环）。
 *
 * 蓝图出处：EP-Orchestrator.md §1 主图 / §4 回流面 / §6 失败语义；conductor launchPart 钉子全抄。
 * 边界纪律：本文件只组装不改引擎——failure-semantics.mjs 的 OrchestratorEngine 一行不动。
 *
 * 夹具隔离（纪律）：progressDir=ORCH_PROGRESS_DIR、遥测目录=PIANIST_TELEMETRY_DIR（shell.mjs 同款）、
 * 会话目录=PIANIST_SESSIONS_DIR、凭证=PORTALK_CRED_DIR/PORTALK_CRED_JOURNAL——全部可注入，
 * 测试全指 tmp，不写生产路径。
 */

import fs from "node:fs";
import path from "node:path";

import { parseCastingSheet } from "./casting-sheet.mjs";
import { SpawnLedger } from "./ledger.mjs";
import { Inbox } from "./inbox.mjs";
import { DualClockSupervisor } from "./supervisor.mjs";
import { OrchestratorEngine } from "./failure-semantics.mjs";
import { RealDriver } from "./driver-real.mjs";
import { HeartbeatWatcher, defaultSessionsDir } from "./heartbeat.mjs";
import { Watchman } from "./watchman.mjs";
import { buildMinionPrompt } from "./prompt-builder.mjs";
import { floorSummaryFromFile } from "./floor-summary.mjs";
import { extractReviewBindings, buildReviewerPrompt } from "./review-chain.mjs";
import { createSessionEndHook } from "./retro-trigger.mjs";
import { emitEvent } from "./emit.mjs";
import { nowJstDay } from "./day-clock.mjs";
import { parseTtlMode, sweepAccountLine } from "../inbox-ttl.mjs";

/** 遥测文件名（shell.mjs telemetryAppend 同款：<agent>-<YYYY-MM-DD>.jsonl） */
function telemetryFileFor(telemetryDir, agentId, spawnAtMs) {
	const day = new Date(spawnAtMs).toISOString().slice(0, 10);
	return path.join(telemetryDir, `${agentId}-${day}.jsonl`);
}

/** 遥测 jsonl → 事件数组（坏行跳过——地板不许因一行坏数据拒出） */
function readTelemetryEvents(file) {
	if (!fs.existsSync(file)) return null;
	const out = [];
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try { out.push(JSON.parse(t)); } catch { /* 坏行跳过 */ }
	}
	return out;
}

/** 文件尾部文本（会话原文源的机械供法） */
function tailText(file, bytes = 4000) {
	try {
		const st = fs.statSync(file);
		const fh = fs.openSync(file, "r");
		const len = Math.min(bytes, st.size);
		const buf = Buffer.alloc(len);
		fs.readSync(fh, buf, 0, len, st.size - len);
		fs.closeSync(fh);
		return buf.toString("utf8");
	} catch {
		return null;
	}
}

/**
 * 组合根（拍板表#1）。
 * @param {object} opts
 * @param {string} opts.sheetText 任务书原文（casting sheet v0 格式）
 * @param {string|null} [opts.piBin] pi 入口（.mjs/.js=stub 直用；缺省 ORCH_PI_BIN env → 默认 bundle）
 * @param {object|null} [opts.supervisorCfg] 双时钟配置；缺省从预算袋时长推导；再缺省=不监督（测试阴性对照用，生产别）
 * @param {Function} [opts.runSandboxed] 沙箱执行器注入位（测试记调用）
 * @param {string} [opts.progressDir/telemetryDir/sessionsDir/cwd/model/shellUrl] 路径面全可注入
 * @param {string|null} [opts.eventsDir]  存在感事件账目录（F3，缺省 ORCH_EVENTS_DIR env → emit.mjs 的 repo 相对 data/events）
 * @param {boolean} [opts.watchman]        看门开关（缺省开；false=不接线，阴性对照/测试位）
 * @param {number} [opts.watchmanSilentMs] 看门静默窗 ms（缺省 120s——宽于常驻 tick 与心跳抖动）
 * @param {boolean} [opts.pollApprovals]   审批上浮轮开关（缺省开；false=不接线，阴性对照位）
 * @param {boolean} [opts.sessionEndHook]   源3收尾钩子 fire 侧开关（缺省开；false=拔线，阴性对照位）
 * @param {Function} [opts.now] 时钟注入（测试假时钟）
 * @returns {{ sheet, ledger, inbox, supervisor, engine, driver, watcher, watchman, sessionEndHook, launchMinion, launchSheet, tick, pollBeats, pollApprovals, sweep, startWatching, stopWatching, startLoop, stop, loopRunning }}
 */
export function buildRuntime({
	sheetText,
	piBin = null,
	supervisorCfg = null,
	runSandboxed,
	cwd = process.cwd(),
	model,
	shellUrl = process.env.PIANIST_SHELL_URL ?? "http://127.0.0.1:8770",
	progressDir = process.env.ORCH_PROGRESS_DIR ?? "/tmp/orch-progress",
	eventsDir = process.env.ORCH_EVENTS_DIR ?? null,
	telemetryDir = process.env.PIANIST_TELEMETRY_DIR ?? path.join(cwd, "data", "telemetry"),
	sessionsDir = defaultSessionsDir(),
	now = Date.now,
	pits = [],
	watchman = true,
	watchmanSilentMs = 120_000,
	pollApprovals = true,
	sessionEndHook = true,
} = {}) {
	const sheet = parseCastingSheet(sheetText); // 书坏了门口拦（CastingSheetError 带具体缺什么）

	// 审链绑定（10/16）：角色表「审链:角色名」声明——施工交付后自动派该角色审（advisory：没声明就不开）
	const reviewBindings = extractReviewBindings(sheet.roles);

	// 双时钟：显式配置 > 预算袋时长 > 不监督（不监督要出声——监督组测试就是为它红的）
	let supCfg = supervisorCfg;
	if (supCfg == null) {
		supCfg = sheet.budget?.durationMs != null ? { timeoutMs: sheet.budget.durationMs } : {};
		if (!(sheet.budget?.durationMs != null)) {
			console.warn("[orch-runtime] 预算袋无时长且未显式配双时钟——监督器未上钟（正常运行必传，蓝图 §6）");
		}
	}
	const supervisor = new DualClockSupervisor(supCfg, now);

	// 分身元数据（心跳源/判活三源的文件面），onSpawn 统一登记——引擎重试 spawn 的分身也走这条路
	const meta = new Map(); // minionId → { telemetryFile, sessionDir, spawnAt }
	const noWatch = new Set(); // 阴性对照位：launchMinion({watch:false}) 的分身不接心跳源

	const ledger = new SpawnLedger();
	const inbox = new Inbox({ now }); // F2：day 打点走注入钟（缺省真钟）——与 sweepExpired 同一座钟（钟屋）
	const emitOpts = eventsDir ? { eventsDir } : {}; // F3 存在感：心跳事件落账位（旁路，写失败不拦一切）

	const watcher = new HeartbeatWatcher({
		onBeat: (minionId, ev) => engine.telemetryEvent(minionId, ev), // 事件推进才喂：引擎里登记台账心跳+重置静默钟+坑账匹配
	});

	const driver = new RealDriver({
		cwd, piBin, model, shellUrl, progressDir, eventsDir, runSandboxed, sheet,
		hardStopMs: supervisor.config.timeoutMs != null
			? supervisor.config.timeoutMs + supervisor.config.graceMs + 2000 // 沙箱路径 executor 硬停兜底（总时钟+宽限+富余）
			: null,
		onSpawn: (minionId, rec) => {
			const m = {
				spawnAt: rec.spawnAt,
				telemetryFile: telemetryFileFor(telemetryDir, rec.agentId, rec.spawnAt),
				sessionDir: sessionsDir,
			};
			meta.set(minionId, m);
			if (!noWatch.has(minionId)) {
				watcher.watch(minionId, m); // 双源接线：会话 mtime ±150s 锁定 + 遥测 tail
			}
		},
		onExit: (minionId, exit) => completionPump(minionId, exit),
		now,
	});

	// 判活三源供法（讣告用）：遥测 jsonl + 会话原文尾；账本收据 v0 无逐笔——缺源降级出声，不装全知
	const sourcesFor = (minionId) => {
		const m = meta.get(minionId);
		if (!m) return {};
		const sources = {};
		const events = m.telemetryFile ? readTelemetryEvents(m.telemetryFile) : null;
		if (events != null) sources.telemetryEvents = events;
		const lockedFiles = watcher.locked(minionId);
		if (lockedFiles.length) {
			const text = tailText(lockedFiles[lockedFiles.length - 1]);
			if (text != null) sources.sessionText = text;
		}
		return sources;
	};

	const engine = new OrchestratorEngine({ ledger, inbox, supervisor, driver, sourcesFor, pits });

	// 看门人（拍板#4）：三判扫尸哨——只喊不定死，收件箱推「讣告候选」；开关可关（阴性对照位）
	const watchmanRef = watchman
		? new Watchman({ ledger, inbox, driver, now, silentWindowMs: watchmanSilentMs })
		: null;

	// 源3 fire 侧（t16-fix 活2，gap H2）：分身退场统一路径——DONE/阻塞/死都算收尾，事件出给注册方。
	// createSessionEndHook 注册位在 retro-trigger，retropad --hook 是现成消费面（源3=加速器不是命脉：
	// 零注册方时 fire 是 no-op，扫描式源1/2 兜底常在）；retropad 自用 buildRuntime（零 handler）不递归。
	// sessionEndHook=false 是拔线位（阴性对照：退场零源3事件）。
	const sessionEnd = sessionEndHook ? createSessionEndHook() : null;
	function fireSessionEnd(minionId, exit, row) {
		if (!sessionEnd) return;
		const tail = exit?.tail ?? "";
		const blocked = /BLOCKED\s*[:：]\s*(歧义|环境)/.test(tail);
		const verdict = /VERDICT\s*[:：]\s*(pass|fail)/i.test(tail);
		const done = exit?.code === 0 && /(^|\n)\s*DONE\b/.test(tail);
		const outcome = exit?.signal != null ? "death" // 信号死（含双时钟收尾的 SIGTERM）也算收尾
			: blocked ? "blocked"
			: verdict ? "verdict"
			: done ? "done"
			: "death"; // 非 0 退出/无协议行=session 死亡形状（与泵下游分支同口径）
		sessionEnd.fire({
			minionId, taskId: row?.taskId ?? null, role: row?.role ?? null,
			outcome, exitCode: exit?.code ?? null, signal: exit?.signal ?? null, ts: now(),
		});
	}

	// 收尾泵：进程退场 → 机械判死活形状（引擎逻辑不动，泵只调引擎的公开口）
	function completionPump(minionId, exit) {
		const row = ledger.get(minionId);
		if (!row) return; // 不经台账的分身不管（无身份无收尾）
		if (!["跑", "等审"].includes(row.status)) return; // 已收/死——不重复收尾
		fireSessionEnd(minionId, exit, row); // 源3：退场即收尾事件（在一切分支之前——信号死早期 return 也算）
		if (exit.signal != null) return; // 信号死=引擎收尾链的事（pendingKill→finalize），泵不抢
		const tail = exit.tail ?? "";
		const blocked = /BLOCKED\s*[:：]\s*(歧义|环境)\s*[:：]?\s*([^\n]*)/.exec(tail);
		if (blocked) {
			const kind = blocked[1] === "歧义" ? "ambiguity" : "env";
			engine.reportBlocked(minionId, { kind, detail: blocked[2]?.trim() || "（分身未写明细）" });
			return;
		}
		// 审链裁决行（10/16）：buildReviewPrompt 教评审员输出 VERDICT:pass/fail——
		// 泵认这个形状：裁决送达（kind=审链裁决，含 verdict/红项全文），台账收工，不再触发审链（评审员角色无声明=终点）
		const verdict = /VERDICT\s*[:：]\s*(pass|fail)/i.exec(tail);
		if (exit.code === 0 && verdict) {
			engine.deliver(minionId, {
				exitCode: exit.code,
				verdict: verdict[1].toLowerCase(),
				tail: tail.slice(-3500),
			});
			// F3 存在感：裁决落收件箱后的心跳事件（旁路账——写失败不拦裁决）
			emitEvent("verdict.received", { minionId, taskId: row?.taskId ?? null, verdict: verdict[1].toLowerCase() }, emitOpts);
			console.log(`[orch-runtime] 审链裁决送达：${minionId} → ${verdict[1].toLowerCase()}`);
			return;
		}
		if (exit.code === 0 && /(^|\n)\s*DONE\b/.test(tail)) {
			const m = meta.get(minionId);
			const floor = m?.telemetryFile ? floorSummaryFromFile(m.telemetryFile) : null;
			// tail 窗 3500B（v2-2）：复盘分身的裁决 JSON 从交货单 manifest.tail 提取（替代旧 stdout 尾部提取），
			// 裁决含 candidate 正文时 300 字窗会拦腰截断 JSON——加宽到 3500（driver 侧尾窗 4000，此处不再窄于它就没意义）
			engine.deliver(minionId, { exitCode: exit.code, tail: tail.slice(-3500), floorSummary: floor });
			// 审链自动编排（10/16 接线）：施工角色声明「审链:评审员」→ 交付后自动派审链分身。
			// 审链分身是独立进程独立台账行（复验者≠施工者），VERDICT 落收件箱，处置归前台。
			const deliveredRow = ledger.get(minionId);
			const reviewEntry = reviewBindings.get(deliveredRow?.role);
			if (reviewEntry) {
				const reviewTaskId = deliveredRow?.taskId ?? `task-${minionId}`;
				try {
					const reviewId = `${minionId}-审-${reviewEntry.role}`;
					const rp = buildReviewerPrompt({
						sheet, revieweeId: minionId, revieweeRole: deliveredRow.role,
						reviewEntry, taskId: reviewTaskId,
						deliverableManifest: { tail: tail.slice(-3500), floorSummary: floor },
					});
					const rec2 = driver.spawn({
						taskId: reviewTaskId, minionId: reviewId, role: reviewEntry.role,
						sheetId: sheet.name, sandbox: reviewEntry.sandbox, pointer: reviewEntry.pointer,
						prompt: rp, model: reviewEntry.model ?? null,
					});
					engine.start({
						taskId: reviewTaskId, minionId: reviewId, role: reviewEntry.role,
						sheetId: sheet.name, startedAt: rec2.spawnAt, sandboxTier: rec2.tier, pointer: reviewEntry.pointer,
					});
					// 审链分身正常发车即可；其退场同样走 completionPump（无审链声明→不再递归）
					console.log(`[orch-runtime] 审链自动发车：${minionId} → ${reviewId}`);
				} catch (err) {
					console.warn(`[orch-runtime] 审链发车失败（交货已送达，审欠着）：${String(err?.message ?? err)}`);
					inbox.deliver("通知", { text: `审链发车失败：${minionId} 的审链 ${reviewEntry.role} 没起来——${String(err?.message ?? err)}` });
				}
			}
			return;
		}
		// 非 0 退出/无协议行：进程没了+协议没来=session 死亡（非硬停）形状，讣告走判活三源
		engine.reportSessionDeath(minionId, { detail: `进程退出 code=${exit.code}，无 DONE 无 BLOCKED（非硬停）` });
	}

	/**
	 * 发车一个分身（首发路径；引擎重试路径由引擎自己调 driver.spawn，onSpawn 统一接线）。
	 * @param {object} p { taskId, role, index=1, minionId=?, watch=true, workaround, failureReason }
	 * @returns spawn 记录 { minionId, pid, sandboxed, tier, ... }
	 */
	function launchMinion({ taskId, role, index = 1, minionId = null, watch = true, workaround = null, failureReason = null }) {
		const roleEntry = sheet.roles.find((r) => r.role === role);
		if (!roleEntry) throw new Error(`launchMinion 角色不在任务书角色表：${role}（在册：${sheet.roles.map((r) => r.role).join("、")}）`);
		const id = minionId ?? `${taskId}-${roleEntry.role}-${index}`;
		if (!watch) noWatch.add(id);
		const prompt = buildMinionPrompt({
			sheet, roleEntry, taskId, minionId: id, index,
			workaround, failureReason, cwd,
		});
		const rec = driver.spawn({
			taskId, minionId: id, role: roleEntry.role, sheetId: sheet.name,
			sandbox: roleEntry.sandbox, pointer: roleEntry.pointer, prompt,
			model: roleEntry.model ?? null, // 角色级模型覆盖（10/16）：角色表「模型:xxx」直达 pi --model
		});
		engine.start({
			taskId, minionId: id, role: roleEntry.role, sheetId: sheet.name,
			startedAt: rec.spawnAt, sandboxTier: rec.tier, pointer: roleEntry.pointer,
		});
		return rec;
	}

	/** 整张任务书发车（角色表 × 数量；返回 spawn 记录序列） */
	function launchSheet({ taskId = `task-${Date.now()}` } = {}) {
		const recs = [];
		for (const roleEntry of sheet.roles) {
			for (let i = 1; i <= (roleEntry.count ?? 1); i++) {
				recs.push(launchMinion({ taskId, role: roleEntry.role, index: i }));
			}
		}
		return recs;
	}

	// ---- 审批上浮轮（the user 10/7 定案①拍板7）：壳的 pending 审批卡 → 收件箱 kind=审批。
	// 主 agent 在收件箱看到机器行+白话行两行（卡片本体）；裁决面归人，v0 不回环——
	// 卡片裁决后 pending 消失，不追投裁决结果。同 id 只投一次；壳不在场=静默跳过出声一次
	// （壳回来后重新出声一次，抖动不刷屏）。pollApprovals=false 是阴性对照位（拔接线）。
	// F2 消费面核对（spec 实现面 3a）：本轮只吃壳 /approvals/pending（仅 status==="pending"）——
	// 过期自动 deny（by=system-expired）的卡不会以 pending 面重现，终态查询走 /approvals/get。
	const approvalsRelayed = new Set(); // 已投过的卡片 id（去重；卡片量小，不设上限）
	let approvalsAbsentWarned = false;
	async function pollApprovalsFn() {
		let cards;
		try {
			const res = await fetch(`${shellUrl}/approvals/pending`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const out = await res.json();
			cards = Array.isArray(out?.pending) ? out.pending : [];
			approvalsAbsentWarned = false; // 壳在场——下次掉线重新出声
		} catch (err) {
			if (!approvalsAbsentWarned) {
				console.warn(`[orch-runtime] 审批轮询够不着壳（${shellUrl}）——pending 审批暂不可见，本轮跳过：${String(err?.message ?? err)}`);
				approvalsAbsentWarned = true;
			}
			return [];
		}
		for (const card of cards) {
			if (typeof card?.id !== "string" || approvalsRelayed.has(card.id)) continue;
			approvalsRelayed.add(card.id);
			inbox.deliver("审批", card); // payload=卡片本体（含 machineLine/plainLine 双行）
		}
		return cards;
	}
	const pollApprovalsFnWired = pollApprovals ? pollApprovalsFn : null;

	// ---- 常驻 tick（拍板#5）：一个 interval 打包 poll→tick→sweep。
	// 顺序 审批→poll→tick→sweep：审批是人的视线面，先拉（fire-and-forget，不阻塞钟面）；
	// poll→tick→sweep 是数据新鲜度序：先喂心跳——刚推进的 beat 先重置静默钟再判钟，
	// 防把刚干完活的分身误收；sweep 殿后，只看判完钟还站着的「跑」行。
	// 时钟走注入 now（缺省 Date.now，拍板#5 原文；测试注入假时钟同一条路）。
	// 本单不部署 systemd：接口先活，部署随实战调（the user「先做出来实战调纪律」）。
	//
	// F2 收件箱按天清（docs/f2-inbox-ttl-spec-v0.2.1.md）：runtime inbox 是本进程的内存队列，
	// 隔夜条目对今天醒来的会话是噪音不是信号——每天首 tick（进程日旗+日界翻篇）day < today
	// 出队（删除不转储不回补；语义 3 帘幕线：清理路径零 spawn 零重派）+ 清理记账行。钟走注入
	// now——与 deliver 打 day 同一座钟（写入与清判同源，验收 6）。mode 逃生门与 conductor 同源
	//（CONDUCTOR_INBOX_TTL；非法值回 day + 出声——fail-fast 住 conductor 常驻面，这里只兜底）。
	let inboxSweepDay = null;
	const inboxTtlMode = (() => {
		const m = parseTtlMode(process.env.CONDUCTOR_INBOX_TTL);
		if (m == null) {
			console.warn(`[orch-runtime] CONDUCTOR_INBOX_TTL="${process.env.CONDUCTOR_INBOX_TTL}" 不认（合法：day|24h|tiered）——回默认 day（正典）。常驻面的 fail-fast 在 conductor`);
			return "day";
		}
		return m;
	})();
	function inboxDailySweep(t) {
		const today = nowJstDay(t);
		if (inboxSweepDay === today) return;
		inboxSweepDay = today;
		const swept = inbox.sweepExpired(t, inboxTtlMode);
		if (swept.length) console.log(sweepAccountLine("[orch-runtime]", swept));
	}
	let loopTimer = null;
	function startLoop(pollMs = 1000) {
		stopLoop();
		loopTimer = setInterval(() => {
			const t = now();
			inboxDailySweep(t); // F2 每天首 tick：先清隔夜粮再拉新卡（审批→poll→tick→sweep 之前）
			if (pollApprovalsFnWired) void pollApprovalsFnWired();
			watcher.poll();
			engine.tick(t);
			watchmanRef?.sweep(t);
		}, pollMs);
		return loopTimer;
	}
	function stopLoop() {
		if (loopTimer) {
			clearInterval(loopTimer);
			loopTimer = null;
		}
	}
	/** 全停（拍板#5 stop）：常驻 tick 清 + 心跳 watcher 停——停转后无句柄持住事件循环，进程能自然退。 */
	function stop() {
		stopLoop();
		watcher.stop();
	}

	return {
		sheet, ledger, inbox, supervisor, engine, driver, watcher, watchman: watchmanRef, sessionEndHook: sessionEnd,
		launchMinion, launchSheet,
		tick: (nowMs) => engine.tick(nowMs),        // 引擎推进（真/假时钟都由调用方注入）
		pollBeats: () => watcher.poll(),             // 手驱心跳轮（测试用；生产用 startWatching/startLoop）
		pollApprovals: () => pollApprovalsFnWired?.() ?? Promise.resolve([]), // 手驱审批轮（测试用；生产走 startLoop；拔接线=空轮）
		pollApprovals: () => pollApprovalsFnWired?.() ?? Promise.resolve([]), // 手驱审批轮（测试用；生产走 startLoop；拔接线=空轮）
		sweep: () => watchmanRef?.sweep() ?? [],     // 手驱看门扫（测试用；生产走 startLoop）
		startWatching: (pollMs) => watcher.start(pollMs),
		stopWatching: () => watcher.stop(),
		startLoop,
		stop,
		loopRunning: () => loopTimer != null,
	};
}
