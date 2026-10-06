/**
 * failure-semantics.mjs — 失败语义表驱动（任务编排器⑧ 施工铲5，蓝图 §6 全表 2026-10-06 zhaozhao定案）
 *
 * 七行全表，表驱动不散落 if：
 *   1 BLOCKED·任务书歧义   分身主动报 → 编排器停手转前台改书（分身不当裁判）→ 通知
 *   2 BLOCKED·环境缺      分身主动报 → fail-fast 讣告写明缺什么 → 讣告
 *   3 BLOCKED·已知坑形状  遥测匹配坑账 → 自动重试 ≤1 次，workaround 注入（失败原因作重试输入）
 *   4 超时（总时钟）      80% 先中断转报告模式写遗言 → SIGTERM→5s→SIGKILL 三级收尾 → 讣告
 *   5 静默（idle-timeout）静默钟到点 → 专捕卡在永不返回工具里的形状 → 讣告
 *   6 session 死亡(非硬停) 心跳断+进程无 → 讣告生成器走判活三源，salvage 已产出 → 讣告
 *   7 二败                同任务第二次失败 → 停止自动处理，讣告升级叫醒主agent
 *
 * 总纪律：同一任务自动重试 ≤1 次，失败原因作重试输入；机器只处理已知形状的失败，
 * 未知形状的失败是人的活。
 *
 * 纯逻辑零 spawn：driver 是注入的驱动器接口（测试用假驱动器记录调用），
 *   { spawn(cfg), sendReport(id), sigterm(id), sigkill(id), isAlive(id) }
 * sourcesFor(minionId) 注入判活三源 { telemetryEvents?, sessionText?, receipts? }。
 */

import { DualClockSupervisor } from "./supervisor.mjs";
import { generateObituary } from "./obituary.mjs";

/** §6 失败语义表（数据不是代码——表是权威，动作实现按 action 键走） */
export const FAILURE_SEMANTICS_TABLE = [
	{ shape: "blocked_ambiguity", judge: "分身主动报", action: "stop_and_hand_to_foreground", inboxKind: "通知" },
	{ shape: "blocked_env", judge: "分身主动报", action: "fail_fast_obituary", inboxKind: "讣告" },
	{ shape: "known_pit", judge: "遥测匹配坑账", action: "retry_once_with_workaround", inboxKind: null },
	{ shape: "timeout", judge: "总时钟到点", action: "report_mode_then_three_tier_kill", inboxKind: "讣告" },
	{ shape: "silent", judge: "静默钟到点", action: "idle_timeout_kill", inboxKind: "讣告" },
	{ shape: "session_death", judge: "心跳断+进程无", action: "obituary_three_sources", inboxKind: "讣告" },
	{ shape: "second_failure", judge: "同任务第二次失败", action: "stop_auto_escalate_wake_main", inboxKind: "讣告" },
];

export class OrchestratorEngine {
	constructor({ ledger, inbox, supervisor, driver, sourcesFor = () => ({}), pits = [] }) {
		if (!ledger || !inbox || !driver) throw new Error("OrchestratorEngine 需要 ledger/inbox/driver");
		this.ledger = ledger;
		this.inbox = inbox;
		this.supervisor = supervisor ?? new DualClockSupervisor(); // 不传=不监督（阴性对照用；正常运行必传双时钟配置）
		this.driver = driver;
		this.sourcesFor = sourcesFor;
		this.pits = pits; // [{ id, match(event), workaround }]——坑账（遥测匹配）
		this.tasks = new Map(); // taskId → { failures[], autoRetryUsed, stopped }
		this.minionTask = new Map(); // minionId → taskId
		this.handledPits = new Set(); // minionId::pitId 去重
		this.pendingKill = new Map(); // minionId → { reason }（SIGTERM 已发，等死/补刀）
		this.finalized = new Set();
		this.events = []; // 编排器自身动作审计（零 LLM，纯记录）
	}

	_log(shape, minionId, detail) {
		this.events.push({ shape, minionId, detail, ts: new Date().toISOString() });
	}

	_task(taskId) {
		if (!this.tasks.has(taskId)) {
			this.tasks.set(taskId, { failures: [], autoRetryUsed: false, stopped: false });
		}
		return this.tasks.get(taskId);
	}

	/** 分身上场：台账登记 + 监督器上钟。timeout/idle 配置在 supervisor 构造时定（来自任务书预算袋/调用方）。 */
	start({ taskId, minionId, role, sheetId, startedAt, sandboxTier = null, pointer = null }) {
		this.ledger.register({ id: minionId, role, sheetId, sandboxTier, pointer, startedAt });
		this.minionTask.set(minionId, taskId);
		const task = this._task(taskId);
		if (!task.minionIds) task.minionIds = [];
		task.minionIds.push(minionId);
		this.supervisor.watch(minionId, { startedAt });
		this._log("spawn_registered", minionId, `task=${taskId} role=${role}`);
		return this.ledger.get(minionId);
	}

	/** 遥测事件入编排器：①登记心跳（台账+静默钟） ②坑账匹配（已知坑形状）。 */
	telemetryEvent(minionId, event) {
		const beat = this.ledger.registerHeartbeat(minionId, { ts: event?.ts, kind: event?.kind, tool: event?.data?.tool });
		const ms = event?.ts != null ? Date.parse(event.ts) : NaN;
		if (Number.isFinite(ms)) this.supervisor.heartbeat(minionId, ms);

		if (!beat.ok) return beat;
		const taskId = this.minionTask.get(minionId);
		if (!taskId) return beat;
		const task = this._task(taskId);
		for (const pit of this.pits) {
			const key = `${minionId}::${pit.id}`;
			if (this.handledPits.has(key) || !pit.match(event)) continue;
			this.handledPits.add(key);
			task.failures.push({ shape: "known_pit", pitId: pit.id, minionId });
			if (task.stopped) return { ...beat, pit: "ignored_task_stopped" };
			if (!task.autoRetryUsed) {
				// 行3：自动重试 ≤1，workaround 注入，失败原因作重试输入
				task.autoRetryUsed = true;
				this.ledger.setStatus(minionId, "死", `known_pit:${pit.id} 重试换人`);
				this.supervisor.forget(minionId);
				this.finalized.add(minionId);
				const row = this.ledger.get(minionId);
				const newId = `${minionId}-retry1`;
				this.driver.spawn({
					taskId, minionId: newId, role: row.role, sheetId: row.sheetId,
					workaround: pit.workaround, failureReason: `known_pit:${pit.id}`, // 失败原因作重试输入
				});
				this.start({ taskId, minionId: newId, role: row.role, sheetId: row.sheetId, startedAt: Date.now(), sandboxTier: row.sandboxTier, pointer: row.pointer });
				this._log("known_pit", minionId, `重试1次→${newId}，注入 workaround=${pit.workaround}`);
				return { ...beat, pit: pit.id, retried: true, newId };
			}
			// 重试名额已用 → 二败升级
			return this._escalate(task, { shape: "second_failure", minionId, cause: "环境", detail: `已知坑形状二次命中：${pit.id}（自动重试名额已用）` });
		}
		return beat;
	}

	/** 推进监督器（假/真时钟都由调用方注入）：把动作打到 driver，收尾入账。 */
	tick(nowMs) {
		const actions = this.supervisor.evaluate(nowMs);
		for (const act of actions) {
			if (act.type === "report_signal") {
				// 80% 阈值：中断转报告模式，给分身发「写遗言」信号（§4.2）
				this.driver.sendReport(act.id);
				const row = this.ledger.get(act.id);
				if (row) {
					this.ledger.setStatus(act.id, "跑");
					this.ledger.rows.get(act.id).reportMode = true;
				}
				this._log("timeout_warn", act.id, "80% 阈值：转报告模式写遗言");
			} else if (act.type === "sigterm") {
				this.driver.sigterm(act.id);
				this.pendingKill.set(act.id, { reason: act.reason });
				this._log(act.reason === "idle_timeout" ? "silent" : "timeout", act.id, `SIGTERM（${act.reason}），宽限 ${this.supervisor.config.graceMs}ms 后补刀`);
			} else if (act.type === "sigkill") {
				this.driver.sigkill(act.id);
				this._finalizeDeath(act.id, act.reason);
			}
		}
		// SIGTERM 后自行退场（优雅死）也收尾
		for (const [id, { reason }] of this.pendingKill) {
			if (!this.finalized.has(id) && this.driver.isAlive(id) === false) {
				this._finalizeDeath(id, reason);
			}
		}
		return actions;
	}

	/** 分身主动报 BLOCKED（歧义/环境缺）。kind: 'ambiguity' | 'env' */
	reportBlocked(minionId, { kind, detail = "" }) {
		const taskId = this.minionTask.get(minionId);
		const row = this.ledger.get(minionId);
		if (kind === "ambiguity") {
			// 行1：停手转前台改书——分身不当裁判，编排器也不当
			this.driver.sigterm(minionId);
			this.pendingKill.delete(minionId);
			this.ledger.setStatus(minionId, "等审", `任务书歧义：${detail}`);
			this.inbox.deliver("通知", {
				reason: "任务书歧义——编排器停手转前台改书（分身不当裁判）",
				detail, minionId, taskId, sheetId: row?.sheetId ?? null,
			});
			this._log("blocked_ambiguity", minionId, detail);
			return { shape: "blocked_ambiguity" };
		}
		if (kind === "env") {
			// 行2：fail-fast 讣告写明缺什么
			return this._failFast(minionId, { shape: "blocked_env", cause: "环境", detail: `环境缺：${detail}` });
		}
		throw new Error(`reportBlocked 未知 kind：${kind}`);
	}

	/** 行6：session 死亡（非硬停）——心跳断+进程无，讣告走判活三源。 */
	reportSessionDeath(minionId, { detail = "session 死亡（非硬停）" } = {}) {
		return this._failFast(minionId, { shape: "session_death", cause: "自杀", detail });
	}

	/** 交货：台账收工 + 交货单送达。 */
	deliver(minionId, manifest) {
		this.supervisor.forget(minionId);
		this.pendingKill.delete(minionId);
		this.ledger.setStatus(minionId, "收");
		return this.inbox.deliver("交货单", { minionId, manifest: manifest ?? null, taskId: this.minionTask.get(minionId) });
	}

	/** 等审（审链中间态：施工完→临时工审→收）。 */
	markAwaitingReview(minionId, note = null) {
		return this.ledger.setStatus(minionId, "等审", note);
	}

	_buildObituary(minionId, cause, causeDetail) {
		const row = this.ledger.get(minionId);
		const sources = this.sourcesFor(minionId) ?? {};
		return generateObituary({ minion: row, cause, causeDetail, sources });
	}

	/** 统一死亡收尾：台账死 + 讣告（二败升级判断在此）+ 收件箱送达。 */
	_failFast(minionId, { shape, cause, detail }) {
		const taskId = this.minionTask.get(minionId);
		const task = taskId ? this._task(taskId) : null;
		this.supervisor.forget(minionId);
		this.pendingKill.delete(minionId);
		this.ledger.setStatus(minionId, "死", detail);

		let escalated = false;
		if (task) {
			task.failures.push({ shape, minionId });
			// 行7：同任务第二次失败 → 停止自动处理 + 讣告升级叫醒主agent
			if (task.failures.length >= 2) escalated = this._markStopped(task);
		}
		const obituary = this._buildObituary(minionId, cause, detail);
		this.inbox.deliver("讣告", { ...obituary, escalated, wakeMainAgent: escalated, taskId });
		this._log(escalated ? "second_failure" : shape, minionId, `${detail}${escalated ? "（二败：停止自动处理，升级叫醒主agent）" : ""}`);
		return { shape: escalated ? "second_failure" : shape, escalated };
	}

	_finalizeDeath(minionId, killReason) {
		if (this.finalized.has(minionId)) return null;
		this.finalized.add(minionId);
		this.pendingKill.delete(minionId);
		const causeDetail = killReason === "idle_timeout"
			? "静默钟（idle-timeout）触发——卡在永不返回的工具里的形状"
			: "总时钟 timeout 到点：SIGTERM→5s→SIGKILL 三级收尾";
		return this._failFast(minionId, {
			shape: killReason === "idle_timeout" ? "silent" : "timeout",
			cause: "超时",
			detail: causeDetail,
		});
	}

	/** 二败升级：停止自动处理，杀在场尝试，讣告升级叫醒主agent。 */
	_escalate(task, { shape, minionId, cause, detail }) {
		this._markStopped(task);
		if (!this.finalized.has(minionId)) {
			this.driver.sigkill(minionId);
			this.finalized.add(minionId);
			this.supervisor.forget(minionId);
			this.pendingKill.delete(minionId);
			this.ledger.setStatus(minionId, "死", `二败升级：${detail}`);
			const obituary = this._buildObituary(minionId, cause, `二败：${detail}`);
			this.inbox.deliver("讣告", { ...obituary, escalated: true, wakeMainAgent: true, taskId: this.minionTask.get(minionId) });
		}
		this._log(shape, minionId, `停止自动处理，升级叫醒主agent：${detail}`);
		return { shape: "second_failure", escalated: true };
	}

	_markStopped(task) {
		task.stopped = true;
		return true;
	}
}
