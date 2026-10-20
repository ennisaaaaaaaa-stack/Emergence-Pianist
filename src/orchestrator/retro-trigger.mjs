/**
 * retro-trigger.mjs — 复盘触发器（自学习闭环 v2 施工 v2-2 第一铲；蓝图 §5 触发器三事件源）
 *
 * 是什么：决定「现在值不值得拉复盘分身」的纯逻辑模块——零 LLM、零 spawn、时钟注入可测。
 * 三事件源（蓝图 §5 原文落位）：
 *   1. 热点阈值：hotspot 报告里 hotspots+errorHotspots 总数 ≥ 阈值（缺省 3，可注入）；
 *      裁决回灌（2026-10-11 wander 认领当晨种子「源①永真」）：只计「上次合法裁决之后仍有
 *      新事件」的活形状（lastTs 晚于裁决时刻）——被裁过的旧账不再永真供弹，真新错形照常点火；
 *   2. 抽检到期：上次复盘时刻 + 间隔 ≥ now（独立状态文件的内嵌时间戳，mtime 兜底）；
 *      无历史 = 立即到期一次（给首战铺路——第一次跑不该被空状态卡住）；
 *   3. 收尾钩子：session 收尾事件回调注册位（钩子坏了扫描式兜底常在——蓝图原话，
 *      钩子只是加速器不是命脉：单个钩子处理器抛错只出声不中断，扫描式源 1/2 常在）。
 *
 * 输出形状：{ fire: true|false, reason: "threshold"|"due"|"hook"|"none", detail }。
 * 判序 = 蓝图列序（threshold > due > hook）：多源同燃时 reason 报最有信息量的那个，
 * fire 本身是或运算——任一源满足即拉。
 *
 * 「零热点 = 不拉分身」的分工：本模块的 due/hook 源可以在零热点时 fire（无历史首战、
 * 收尾扫一遍都是合法拉起理由），「不拉分身」由 retropad 的零热点早退闸（闸门三）保证——
 * 触发器决定「要不要跑一趟 retropad」，报告内容决定「要不要拉分身」。两层各管各的。
 *
 * 边界：不碰壳接口、不碰山海库、不碰 conductor——状态文件是本模块自己的账本。
 */

import fs from "node:fs";
import path from "node:path";

export const RETRO_TRIGGER_REASONS = ["threshold", "due", "hook", "none"];

/** 源1缺省阈值：热点数 ≥3 拉复盘（蓝图 §5「热点阈值」建议值，可注入） */
export const DEFAULT_HOTSPOT_THRESHOLD = 3;

/** 源2缺省间隔：6 小时（抽检考期——v0 不拍死，蓝图 §8 开放问题 1 同族：先跑起来实战调） */
export const DEFAULT_RETRO_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** hotspot 报告 → 热点总数（hotspots + errorHotspots；形状不对按 0 计，不炸——纯函数不抛脏输入） */
export function hotspotTotal(report) {
	if (!report || typeof report !== "object") return 0;
	const h = Array.isArray(report.hotspots) ? report.hotspots.length : 0;
	const e = Array.isArray(report.errorHotspots) ? report.errorHotspots.length : 0;
	return h + e;
}

/**
 * 单形状活判（裁决回灌的逐形状面，2026-10-11 晚班落）：lastTs 晚于裁决时刻=活；
 * 缺 lastTs / 无历史（sinceMs 非法）→ 按活（年龄不明保守向多燃不少燃）。
 * 触发器计数（liveHotspotTotal）与 retropad 任务书标记（活/旧账）共用这一面——
 * 「什么算活」只许有一个事实源，两侧漂移等于给裁决者看假 freshness。
 */
export function isLiveShape(spot, sinceMs) {
	if (sinceMs == null || !Number.isFinite(sinceMs)) return true;
	const t = toMs(spot?.lastTs);
	return t == null || t > sinceMs;
}

/**
 * 活热点数（裁决回灌）：只计 lastTs 晚于裁决时刻 sinceMs 的形状——旧账已判过不永真供弹。
 * sinceMs null/非法（无历史）→ 全按活计（首战铺路）；形状缺 lastTs → 按活计（年龄不明
 * 保守向多燃不少燃——宁可多拉一场复盘，不可静默吞掉新错形）。复活自愈：同形新事件
 * 让 lastTs 走新，自然重新计龄，零额外状态。
 */
export function liveHotspotTotal(report, sinceMs) {
	if (!report || typeof report !== "object") return 0;
	if (sinceMs == null || !Number.isFinite(sinceMs)) return hotspotTotal(report);
	let live = 0;
	for (const arr of [report.hotspots, report.errorHotspots]) {
		if (!Array.isArray(arr)) continue;
		for (const spot of arr) {
			if (isLiveShape(spot, sinceMs)) live++;
		}
	}
	return live;
}

/** 时间值归一：ms 数字 | ISO 字符串 | Date → ms；不可解析 → null（坏状态当无历史，出声在 detail） */
function toMs(v) {
	if (v == null) return null;
	if (v instanceof Date) return v.getTime();
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	if (typeof v === "string") {
		const t = Date.parse(v);
		return Number.isNaN(t) ? null : t;
	}
	return null;
}

const mins = (ms) => Math.round(ms / 60_000);

/**
 * 触发器主体（纯函数，时钟注入）。
 * @param {object} p
 * @param {object|null} [p.report]          hotspot 报告（解析后的对象；null=按零热点计）
 * @param {number} [p.threshold]            源1阈值（缺省 3；非法值 fail-load——阈值是纪律不是装饰）
 * @param {number|string|Date|null} [p.lastRetroAt] 上次复盘时刻（ms/ISO/Date；null=无历史→立即到期）
 * @param {number} [p.intervalMs]           源2抽检间隔 ms（缺省 6h）
 * @param {boolean} [p.hookFired]           源3：session 收尾钩子事件是否在场
 * @param {number|Function} [p.now]         时钟注入（ms 或 () => ms；缺省 Date.now）
 * @returns {{ fire: boolean, reason: "threshold"|"due"|"hook"|"none", detail: string }}
 */
export function evaluateRetroTrigger({
	report = null,
	threshold = DEFAULT_HOTSPOT_THRESHOLD,
	lastRetroAt = null,
	intervalMs = DEFAULT_RETRO_INTERVAL_MS,
	hookFired = false,
	now = Date.now,
} = {}) {
	if (!Number.isFinite(threshold) || threshold < 1) {
		throw new RangeError(`retro-trigger 阈值非法：${threshold}（必须 ≥1 的有限数——阈值是纪律不是装饰）`);
	}
	if (!Number.isFinite(intervalMs) || intervalMs < 1) {
		throw new RangeError(`retro-trigger 抽检间隔非法：${intervalMs}（必须 ≥1ms）`);
	}
	const nowMs = toMs(typeof now === "function" ? now() : now) ?? Date.now();
	const total = hotspotTotal(report);
	const lastMs = toMs(lastRetroAt);
	const lastNote = lastMs == null ? "无有效历史" : `${mins(Math.max(0, nowMs - lastMs))} 分钟前`;

	// 源1：热点阈值（机械可测的事件面——热点攒够就是事件，最有信息量，先判）。
	// 裁决回灌：裁决时刻 = lastRetroAt。合法收工（nothing/candidates）与非法收工（v3 三修③，
	// 2026-10-17：失败也落账 verdict=failed——due 源不空转）都写状态，只计活形状。防的是：
	// 良性形状永居阈值上界 → threshold 与 due 退化成同一个 6h 节拍器，「出现新热点」不再携带信息。
	const live = liveHotspotTotal(report, lastMs);
	if (live >= threshold) {
		return { fire: true, reason: "threshold", detail: `热点 ${live}/${total} 个活（裁决后新事）≥ 阈值 ${threshold}（hotspots+errorHotspots）` };
	}
	// 源2：抽检到期（无历史=立即到期一次，给首战铺路——空状态不该卡住第一次复盘）
	if (lastMs == null) {
		return { fire: true, reason: "due", detail: `无复盘历史——立即到期一次（给首战铺路）；当前热点 ${live}/${total} < 阈值 ${threshold}` };
	}
	const ageMs = nowMs - lastMs;
	if (ageMs >= intervalMs) {
		return { fire: true, reason: "due", detail: `抽检到期：上次复盘 ${mins(ageMs)} 分钟前 ≥ 间隔 ${mins(intervalMs)} 分钟；热点 ${live}/${total} < 阈值 ${threshold}` };
	}
	// 源3：收尾钩子（加速器不是命脉——扫描式源 1/2 不满足时，钩子事件仍可拉起扫一遍）
	if (hookFired) {
		return { fire: true, reason: "hook", detail: `session 收尾钩子触发（加速器）：热点 ${total} < 阈值 ${threshold}，未到期（上次复盘 ${lastNote}）` };
	}
	return {
		fire: false,
		reason: "none",
		detail: `三源全不满足：热点 ${live}/${total} < 阈值 ${threshold}（活/总，裁决回灌后）；上次复盘 ${lastNote} < 间隔 ${mins(intervalMs)} 分钟；无收尾钩子事件`,
	};
}

/**
 * 读复盘状态文件：{ lastRetroAt: ms|null, source: "json"|"mtime"|"none", raw }。
 * 内嵌时间戳优先；JSON 坏/缺字段 → 文件 mtime 兜底（指针原文允许两源）；文件不存在 → 无历史。
 */
export function readRetroState(stateFile) {
	if (typeof stateFile !== "string" || !stateFile.trim()) {
		throw new Error(`retro-trigger 状态文件路径非法：${JSON.stringify(stateFile)}`);
	}
	if (!fs.existsSync(stateFile)) return { lastRetroAt: null, source: "none", raw: null };
	try {
		const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
		const ms = toMs(raw?.lastRetroAt);
		if (ms != null) return { lastRetroAt: ms, source: "json", raw };
	} catch {
		/* 坏 JSON → mtime 兜底（半截写入/手改坏都当「文件在、时间看 mtime」） */
	}
	const ms = toMs(fs.statSync(stateFile).mtime);
	return { lastRetroAt: ms, source: "mtime", raw: null };
}

/**
 * 写复盘状态文件（复盘收工后由 retropad 调）：记 lastRetroAt（ISO）+ runs 累计 + extra。
 * v3 三修③（2026-10-17）：非法收工也写（extra.verdict="failed"）——死亡落账，due 源不空转；
 * 下一场读 verdict=failed 批次自适应减半，连续两死出声报修（消费面在 retropad）。
 * 只记事实不做判断——runs/verdict 是给巡检看的账，due 判定只读 lastRetroAt。
 */
export function writeRetroState(stateFile, atMs = Date.now(), extra = {}) {
	const at = toMs(atMs) ?? Date.now();
	fs.mkdirSync(path.dirname(stateFile), { recursive: true });
	const prev = fs.existsSync(stateFile) ? readRetroState(stateFile) : { raw: null };
	const runs = (prev.raw && Number.isFinite(prev.raw.runs) ? prev.raw.runs : 0) + 1;
	fs.writeFileSync(
		stateFile,
		JSON.stringify({ v: 1, lastRetroAt: new Date(at).toISOString(), runs, ...extra }, null, 2) + "\n",
	);
	return { lastRetroAt: at, runs };
}

/**
 * 源3 回调注册位：session 收尾事件的钩子登记处（蓝图 §5「收尾钩子」）。
 * fire 侧接线（t16-fix 活2，2026-10-17）：runtime.mjs completionPump 分身退场统一路径
 * （DONE/阻塞/死都算收尾）调 fire()——此前注册位/参数位全在、全仓零 fire 方（gap H2）。
 * 钩子坏了扫描式兜底常在——单个处理器抛错：出声（onError）跳过，不影响其余处理器、不炸调用方。
 * fire() 返回 { handlers, fired, failed }——失败数 >0 时调用方自行决定要不要走扫描式补扫。
 */
export function createSessionEndHook({
	onError = (err, event) => console.warn(`[retro-trigger] 收尾钩子处理器抛错（跳过它，其余照跑——钩子是加速器不是命脉）：${err?.message ?? err}`),
} = {}) {
	const handlers = new Set();
	return {
		/** 登记一个收尾钩子；返回注销函数 */
		register(fn) {
			if (typeof fn !== "function") throw new TypeError(`收尾钩子必须是函数，got ${typeof fn}`);
			handlers.add(fn);
			return () => handlers.delete(fn);
		},
		size() {
			return handlers.size;
		},
		/** session 收尾事件到达：逐个调处理器（快照遍历——处理器内注销自己不炸迭代） */
		fire(event = {}) {
			let fired = 0;
			let failed = 0;
			for (const fn of [...handlers]) {
				try {
					fn(event);
					fired++;
				} catch (err) {
					failed++;
					onError(err, event);
				}
			}
			return { handlers: handlers.size, fired, failed };
		},
	};
}
