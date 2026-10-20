/**
 * evaluator.mjs — schedule 评估器纯函数（2026-10-12 schedule-bone 施工）
 *
 * 是什么：决定「现在该触发哪些日程条目」的纯逻辑模块——零 LLM、零 spawn、零 IO、时钟注入
 * 可测（对齐 retro-trigger.mjs 的形状）。spec 权威：docs/schedule-spec-v0.1.md（六条拍板）。
 *
 * 拍板落位：
 *   ① conductor 日程表非 cron——本模块只做判定，消费在 conductor tick（单一入口：预算/
 *      遥测/审批全走既有闸）；
 *   ③ 权限三档 no-ask / auto-safe / always-ask，默认 always-ask（信任要挣得）；auto-safe 与
 *      always-ask 生效前走 ACTION_RISK 分流（复用 queue-core 的 classify——amber 自动过、
 *      red 挂审批，单一事实源不抄第二份正则）；
 *   ④ 活动时间不硬编码≠随便漂：默认北京 10:00-22:00，env（CONDUCTOR_ACTIVE_HOURS）与
 *      文件（active-hours.json）双通道可调，agent 自适应是后续活——本期只留通道；
 *   ⑤ 粒度复合带参数：{id, window:{start,end}, part, params, intent, created_by, status}
 *      ——params 原样透传给 part 的牌面构造（前端可视化吃结构化数据）；
 *   ⑥ 错过=跳过不补跑：LAST 时窗已过 → 该条目本轮不触发不排队，没有补跑队列（判 skipped
 *      由存储侧落 status，终态不再审）。
 *
 * 条目状态词汇（消费侧）：pending（落地待确认——always-ask 默认世界的入场形状）/ approved
 *（已确认，生效）/ fired / skipped / rejected / cancelled / failed（后五者为终态）。
 * draft 是 agent 排草稿生命周期的形状，不落 conductor 日程表——在场即忽略（没落地的不消费）。
 *
 * 边界：不碰壳接口、不 spawn、不读写文件（文件面在 store.mjs / conductor 接线）；坏形状
 * 条目计入 ignored.invalid 不炸——纯函数不抛脏输入（同 retro-trigger 容错口径）。
 */

import { classify } from "../queue-core.mjs";

export const PERMISSION_TIERS = ["no-ask", "auto-safe", "always-ask"];
export const DEFAULT_PERMISSION_TIER = "always-ask";
export const DEFAULT_ACTIVE_HOURS = "10:00-22:00"; // 初始预设北京时间（spec §五1；env/文件双通道可调）
export const DEFAULT_ENTRY_STATUS = "pending"; // always-ask 默认世界：落地即待确认
export const TERMINAL_ENTRY_STATUSES = ["fired", "skipped", "rejected", "cancelled", "failed"];
export const ACTIVE_ENTRY_STATUSES = ["pending", "approved"];

/** 北京时区偏移（UTC+8，无夏令时——活动窗的钟是北京墙钟） */
const BEIJING_OFFSET_MS = 8 * 3600_000;

/** 时间值归一：ms 数字 | ISO 字符串 | Date → ms；不可解析 → null（同 retro-trigger toMs 口径） */
export function toMs(v) {
	if (v == null) return null;
	if (v instanceof Date) return v.getTime();
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	if (typeof v === "string") {
		const t = Date.parse(v);
		return Number.isNaN(t) ? null : t;
	}
	return null;
}

/** now → 北京墙钟当日分钟数（0..1439）。活动窗判定只认北京钟，与部署机时区无关。 */
export function beijingMinuteOfDay(nowMs) {
	const iso = new Date(toMs(nowMs) + BEIJING_OFFSET_MS).toISOString();
	return Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
}

/** now → 北京墙钟 "HH:MM"（判定行/日志用） */
export function beijingHHMM(nowMs) {
	const m = beijingMinuteOfDay(nowMs);
	return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/**
 * 活动窗字符串解析："HH:MM-HH:MM"（容忍两侧空白）。
 * end 允许 "24:00"（=当日终点）；start > end = 跨午夜环绕（如 "22:00-06:00"）；
 * start === end（零长窗）/越界/形状不对 → null（无效值由调用方决定回落哪条通道）。
 */
export function parseActiveHours(raw) {
	if (typeof raw !== "string") return null;
	const m = raw.trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
	if (!m) return null;
	const start = Number(m[1]) * 60 + Number(m[2]);
	const end = Number(m[3]) * 60 + Number(m[4]);
	if (start < 0 || start > 1439 || end < 1 || end > 1440) return null;
	if (start === end) return null;
	return { start, end, startHHMM: `${m[1].padStart(2, "0")}:${m[2]}`, endHHMM: `${m[3].padStart(2, "0")}:${m[4]}`, wrap: start > end };
}

/**
 * 活动窗解析（双通道，spec §五1）：env > 文件 > 默认值北京 10:00-22:00。
 * 双通道语义：env 是运维面（部署期钉死，优先）；文件是 agent 自适应的调整通道（后续活写
 * 这里，本期只留通道）；都缺/都坏 → 默认值兜底（不硬编码≠没有初始值）。
 * @returns {{ start: string, end: string, source: "env"|"file"|"default", inWindow: boolean, beijing: string, invalid: string[] }}
 */
export function resolveActiveWindow({ envHours, fileHours, now = Date.now } = {}) {
	const nowMs = toMs(typeof now === "function" ? now() : now) ?? Date.now();
	const invalid = [];
	let parsed = null;
	let source = "default";
	const envParsed = parseActiveHours(envHours);
	if (envHours !== undefined && envHours !== null && envParsed === null) invalid.push("env");
	const fileParsed = parseActiveHours(fileHours);
	if (fileHours !== undefined && fileHours !== null && fileParsed === null) invalid.push("file");
	if (envParsed) { parsed = envParsed; source = "env"; }
	else if (fileParsed) { parsed = fileParsed; source = "file"; }
	else { parsed = parseActiveHours(DEFAULT_ACTIVE_HOURS); source = "default"; }
	const m = beijingMinuteOfDay(nowMs);
	const inWindow = parsed.wrap ? (m >= parsed.start || m < parsed.end) : (m >= parsed.start && m < parsed.end);
	return {
		start: parsed.startHHMM, end: parsed.endHHMM, source, inWindow,
		beijing: beijingHHMM(nowMs), invalid,
	};
}

/**
 * 档位解析（三档，默认 always-ask）：entry.permission（条目级——确认流程可逐条钉档，
 * 最转一）> env（CONDUCTOR_SCHEDULE_PERMISSION，运维面部署期钉死）> 文件
 * default_permission（schedule 数据自带）> 默认 always-ask。任一级值不认（不在
 * PERMISSION_TIERS）→ 跳过该级看下一级（不炸、不自行放宽到 no-ask）。env 压文件与
 * CONDUCTOR_ACTIVE_HOURS > active-hours.json 同规：运维面优先于数据/调整通道。
 */
export function resolvePermissionTier(entry, { fileDefault, envTier } = {}) {
	if (PERMISSION_TIERS.includes(entry?.permission)) return { tier: entry.permission, source: "entry" };
	if (PERMISSION_TIERS.includes(envTier)) return { tier: envTier, source: "env" };
	if (PERMISSION_TIERS.includes(fileDefault)) return { tier: fileDefault, source: "file" };
	return { tier: DEFAULT_PERMISSION_TIER, source: "default" };
}

/**
 * 条目风险分级（复用 ACTION_RISK 分流——queue-core classify 单一事实源）：
 *   - params.command 是非空字符串 → 走 bash 深判（红/灰区正则同款：递归删除类=red，
 *     git/npm/sudo 类=amber）——条目带命令面的危险操作不许混过 auto-safe；
 *   - 其余 → classify("schedule_fire")：不在 ACTION_RISK 表 = silent（排班本身不是写操作）。
 * classifyFn 可注入（测试替身），缺省真身。
 */
export function scheduleEntryRisk(entry, classifyFn = classify) {
	const cmd = entry?.params?.command;
	if (typeof cmd === "string" && cmd.trim()) {
		return classifyFn("bash", { command: cmd });
	}
	return classifyFn("schedule_fire", { part: entry?.part, intent: entry?.intent, params: entry?.params });
}

/**
 * 触发闸（消费侧三档，spec §四3）：
 *   - no-ask：排好即生效，无需询问 → fire；
 *   - auto-safe：无危险操作自动通过——ACTION_RISK 分流 red 挂审批（不 fire），amber/silent 过；
 *   - always-ask：必须审批才生效——条目 status 须为 approved 才 fire，否则挂待审批。
 * 返回 { fire, why, risk }——why 是可断言面（判定行用），risk 恒带（报告面）。
 */
export function evaluateFireGate(entry, tier, classifyFn = classify) {
	const risk = scheduleEntryRisk(entry, classifyFn);
	if (tier === "no-ask") return { fire: true, why: "no-ask", risk };
	if (tier === "auto-safe") {
		return risk === "red"
			? { fire: false, why: "red-pending", risk }
			: { fire: true, why: `auto-safe:risk=${risk}`, risk };
	}
	// always-ask（默认档）：审批才生效
	return entry?.status === "approved"
		? { fire: true, why: "always-ask:approved", risk }
		: { fire: false, why: "pending-approval", risk };
}

/** 条目形状校验：id/window/part 三件齐 + 时窗可解析且 start ≤ end。返回 {startMs, endMs} 或 {invalid: 原因}。 */
function entryWindowMs(entry) {
	const w = entry?.window;
	if (!w || typeof w !== "object") return { invalid: "window 缺失" };
	const startMs = toMs(w.start);
	const endMs = toMs(w.end);
	if (startMs == null) return { invalid: "window.start 不可解析" };
	if (endMs == null) return { invalid: "window.end 不可解析" };
	if (startMs > endMs) return { invalid: "window.start 晚于 end" };
	return { startMs, endMs };
}

/**
 * 评估器主体（纯函数，时钟注入）：schedule + now → 应触发条目。
 *
 * 判序：形状 → 终态忽略 → draft 忽略 → 未到窗（waiting）→ 错过（skipped，不排队）→
 * 窗口命中 → 活动窗闸（窗外=held，等活跃时段；不是错过）→ 权限闸（held 或 due）。
 * due 按 window.start 升序（多条同燃时早窗先吃——确定性，不靠运气）。
 *
 * @param {object} p
 * @param {object|null} [p.schedule]        日程表（readSchedule 的产物；null/坏形状按空表）
 * @param {number|string|Date|Function} [p.now] 时钟注入（缺省 Date.now）
 * @param {string} [p.envTier]              env 档位（CONDUCTOR_SCHEDULE_PERMISSION 原文）
 * @param {string} [p.envHours]             env 活动窗（CONDUCTOR_ACTIVE_HOURS 原文）
 * @param {string} [p.fileHours]            文件活动窗（active-hours.json 的 activeHours 原文）
 * @param {Function} [p.classifyFn]         ACTION_RISK 分流注入（缺省 queue-core classify）
 * @returns {{
 *   now: number,
 *   activeWindow: { start, end, source, inWindow, beijing, invalid },
 *   due: Array<{ entry, tier, tierSource, risk, why }>,
 *   skipped: Array<{ entry, why }>,        // 错过=跳过（LAST 时窗已过；不排队不补跑）
 *   held: Array<{ entry, tier, risk, why }>,// 窗口命中但被闸拦：outside-active-hours | pending-approval | red-pending
 *   waiting: number,                       // 还没到窗
 *   ignored: { terminal: number, draft: number, invalid: Array<{ id, why }> },
 * }}
 */
export function evaluateSchedule({
	schedule = null,
	now = Date.now,
	envTier,
	envHours,
	fileHours,
	classifyFn = classify,
} = {}) {
	const nowMs = toMs(typeof now === "function" ? now() : now) ?? Date.now();
	const entries = Array.isArray(schedule?.entries) ? schedule.entries : [];
	const fileDefault = schedule?.default_permission;
	const activeWindow = resolveActiveWindow({ envHours, fileHours, now: nowMs });
	const out = {
		now: nowMs,
		activeWindow,
		due: [],
		skipped: [],
		held: [],
		waiting: 0,
		ignored: { terminal: 0, draft: 0, invalid: [] },
	};
	for (const entry of entries) {
		if (!entry || typeof entry !== "object") { out.ignored.invalid.push({ id: undefined, why: "条目非对象" }); continue; }
		const status = entry.status ?? DEFAULT_ENTRY_STATUS;
		if (TERMINAL_ENTRY_STATUSES.includes(status)) { out.ignored.terminal += 1; continue; }
		if (status === "draft") { out.ignored.draft += 1; continue; }
		const win = entryWindowMs(entry);
		if (win.invalid) { out.ignored.invalid.push({ id: entry.id, why: win.invalid }); continue; }
		if (typeof entry.part !== "string" || !entry.part.trim()) { out.ignored.invalid.push({ id: entry.id, why: "part 缺失" }); continue; }
		if (nowMs < win.startMs) { out.waiting += 1; continue; }
		if (nowMs > win.endMs) { out.skipped.push({ entry, why: "window-passed" }); continue; } // 错过=跳过（§五3）
		// 窗口命中：先活动窗（§五1 人类活动时间——窗外的骨头等活跃时段，不是错过）
		if (!activeWindow.inWindow) {
			out.held.push({ entry, tier: null, risk: null, why: "outside-active-hours" });
			continue;
		}
		const { tier, source } = resolvePermissionTier(entry, { fileDefault, envTier });
		const gate = evaluateFireGate(entry, tier, classifyFn);
		if (gate.fire) out.due.push({ entry, tier, tierSource: source, risk: gate.risk, why: gate.why });
		else out.held.push({ entry, tier, risk: gate.risk, why: gate.why });
	}
	out.due.sort((a, b) => toMs(a.entry.window.start) - toMs(b.entry.window.start));
	return out;
}
