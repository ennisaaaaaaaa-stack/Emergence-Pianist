/**
 * supervisor.mjs — 双时钟监督器（任务编排器⑧ 施工铲4，蓝图 §6 超时/静默两行；供体 pi-subagents）
 *
 * 总时钟（timeout）管「干不完」：到 80% warn-threshold 先中断转报告模式（给分身发
 * 「写遗言」信号——§4.2 报告模式）；到点 SIGTERM → 5s → SIGKILL 三级收尾。
 * 静默钟（idle-timeout）专捕「卡在永不返回的工具里」的形状；与总时钟独立，可单设可双设。
 *
 * !!! 硬提醒（写在代码里，不靠记忆）：静默钟设值必须高于最慢单次工具调用
 *     （如全套 npm test 的时长）——低于它就是把正在跑慢工具的分身误杀。
 *     这条不能机械强制（监督器不知道最慢工具有多慢），validateSupervisorConfig
 *     对每个设了 idle 的配置都出 warning 提醒；调用方可传 slowestToolMs 提示值，
 *     给了就能机械比对，低于必报。
 *
 * 参数校验纪律（pi-subagents 原话的精神）：timeout/idle-timeout 非法值必须
 * fail-load——负数/NaN/typo 字符串（"25mn"）一律构造即抛，**typo 不许静默变成
 * 「无限制」**——那正是这两个字段要防的病。
 *
 * 纯逻辑零 spawn：时钟注入（now 回调），动作以数据返回（evaluate → actions[]），
 * 由编排器引擎负责打到 driver 上——测试全用假时钟假 driver。
 */

export class TimeoutConfigError extends Error {
	constructor(message) {
		super(message);
		this.name = "TimeoutConfigError";
	}
}

const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/**
 * 解析单个超时值。合法：正数（毫秒）或 "90s"/"25m"/"2h"/"300ms"。
 * 非法（负数/NaN/typo/零）→ 抛 TimeoutConfigError，绝不静默放行。
 */
export function parseTimeoutValue(v, field) {
	if (typeof v === "number") {
		if (!Number.isFinite(v) || v <= 0) {
			throw new TimeoutConfigError(`${field} 非法值：${v}（必须为正数毫秒或 "25m"/"90s"/"2h" 字符串）`);
		}
		return v;
	}
	if (typeof v !== "string") {
		throw new TimeoutConfigError(`${field} 非法值：${String(v)}（支持正数毫秒或 "25m"/"90s"/"2h" 字符串；不设就显式传 null，typo 不许静默变「无限制」）`);
	}
	const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(v.trim());
	if (!m) {
		throw new TimeoutConfigError(`${field} 非法值："${v}" ——fail-load（合法：数字毫秒，或 "300ms"/"90s"/"25m"/"2h"；"25mn" 这类 typo 正是要防的病）`);
	}
	const n = Number(m[1]);
	if (!(n > 0)) throw new TimeoutConfigError(`${field} 非法值："${v}"（必须 >0）`);
	return n * UNIT_MS[m[2]];
}

/**
 * 校验+归一双时钟配置。返回 { timeoutMs, idleTimeoutMs, graceMs, warnThreshold, warnings }。
 * 两个钟都可单设；都不设 = 不监督（isArmed=false——阴性对照/突变测试用，正常运行别这么开）。
 */
export function validateSupervisorConfig({
	timeoutMs = null, idleTimeoutMs = null, graceMs = 5000, warnThreshold = 0.8, slowestToolMs = null,
} = {}) {
	const warnings = [];
	const timeout = timeoutMs == null ? null : parseTimeoutValue(timeoutMs, "timeout");
	const idle = idleTimeoutMs == null ? null : parseTimeoutValue(idleTimeoutMs, "idle-timeout");
	if (!Number.isFinite(graceMs) || graceMs < 0) throw new TimeoutConfigError(`graceMs 非法值：${graceMs}`);
	if (!(warnThreshold > 0 && warnThreshold <= 1)) throw new TimeoutConfigError(`warnThreshold 非法值：${warnThreshold}（须 ∈(0,1]）`);

	if (idle != null) {
		// 硬提醒落 warning：不能机械强制，但每个 idle 配置都必须过一遍这条话
		warnings.push(
			`静默钟设值必须高于最慢单次工具调用（如全套 npm test）——当前 idle-timeout=${idle}ms。此条不能机械强制，设值者自查。`,
		);
		if (slowestToolMs != null && idle <= slowestToolMs) {
			warnings.push(
				`idle-timeout(${idle}ms) 不高于已知最慢单次工具调用(${slowestToolMs}ms)——大概率误杀正在跑慢工具的分身，请调高。`,
			);
		}
	}
	return { timeoutMs: timeout, idleTimeoutMs: idle, graceMs, warnThreshold, warnings };
}

export class DualClockSupervisor {
	/**
	 * @param {object} cfg 同 validateSupervisorConfig；now 注入时钟（测试假时钟）。
	 */
	constructor(cfg = {}, now = Date.now) {
		this.config = validateSupervisorConfig(cfg);
		this.now = now;
		this.states = new Map(); // id → 状态机
		this.warnings = this.config.warnings;
	}

	isArmed() {
		return this.config.timeoutMs != null || this.config.idleTimeoutMs != null;
	}

	/** 登记监督一个分身（起时默认 now()；测试传显式假时基） */
	watch(id, { startedAt = this.now() } = {}) {
		this.states.set(id, {
			startedAt,
			lastEventAt: startedAt,
			reportSent: false,
			sigtermAt: null,
			sigtermReason: null,
			sigkillSent: false,
			finished: false,
		});
		return this.states.get(id);
	}

	/** 心跳：遥测事件驱动（编排器被动收事件时调），重置静默钟 */
	heartbeat(id, atMs = this.now()) {
		const st = this.states.get(id);
		if (!st) return false;
		st.lastEventAt = atMs;
		return true;
	}

	forget(id) {
		return this.states.delete(id);
	}

	stateOf(id) {
		const st = this.states.get(id);
		return st ? { ...st } : null;
	}

	/**
	 * 推进到 now，吐出该执行的动作（幂等：状态随发随记，重复 evaluate 不重发）：
	 *   { id, type: 'report_signal'|'sigterm'|'sigkill', reason: 'total_timeout'|'idle_timeout'|'total_timeout_warn' }
	 * 引擎负责把动作打到 driver；监督器只管什么时候该打。
	 */
	evaluate(nowMs = this.now()) {
		const { timeoutMs, idleTimeoutMs, graceMs, warnThreshold } = this.config;
		const actions = [];
		for (const [id, st] of this.states) {
			if (st.finished || st.sigkillSent) { st.finished = true; continue; }

			// 收尾链进行中：SIGTERM 已发 → 宽限期满且还活着 → SIGKILL
			if (st.sigtermAt != null) {
				if (nowMs - st.sigtermAt >= graceMs) {
					st.sigkillSent = true;
					actions.push({ id, type: "sigkill", reason: st.sigtermReason });
				}
				continue;
			}

			// 总时钟：80% 先报告模式写遗言，到点 SIGTERM（跳过 80% 直接到点的，补发报告信号尽力遗言）
			if (timeoutMs != null) {
				const elapsed = nowMs - st.startedAt;
				if (elapsed >= timeoutMs) {
					if (!st.reportSent) {
						st.reportSent = true;
						actions.push({ id, type: "report_signal", reason: "total_timeout_warn" });
					}
					st.sigtermAt = nowMs;
					st.sigtermReason = "total_timeout";
					actions.push({ id, type: "sigterm", reason: "total_timeout" });
					continue;
				}
				if (!st.reportSent && elapsed >= timeoutMs * warnThreshold) {
					st.reportSent = true;
					actions.push({ id, type: "report_signal", reason: "total_timeout_warn" });
				}
			}

			// 静默钟：连续无输出超限（独立于总时钟，可单设）——卡在永不返回工具的形状，直接进收尾链
			if (idleTimeoutMs != null && st.sigtermAt == null) {
				if (nowMs - st.lastEventAt >= idleTimeoutMs) {
					st.sigtermAt = nowMs;
					st.sigtermReason = "idle_timeout";
					actions.push({ id, type: "sigterm", reason: "idle_timeout" });
				}
			}
		}
		return actions;
	}
}
