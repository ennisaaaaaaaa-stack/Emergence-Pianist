/**
 * inbox-ttl.mjs — 收件箱按天清的判定件（F2，spec：docs/f2-inbox-ttl-spec-v0.2.1.md）
 *
 * 是什么：TTL 模式解析 + 过期判定 + 清理记账行——runtime inbox（orchestrator/inbox.mjs）与
 * 壳审批卡（queue-core.mjs ApprovalQueue）两把刀共用的单一事实源。钟是 day-clock.mjs 的
 * nowJstDay()（钟屋单点：day 写入与清理判定同源调用，spec「钟屋」节），本文件不另立钟。
 *
 * 模式（spec 实现面 6，env 逃生门 CONDUCTOR_INBOX_TTL）：
 *   day    = 方案 A 正典（the user 10/18 拍板 + 10/19 窗口参数拍板）：自然日界（JST 0:00 一刀切），
 *            day < today 的条目出队——与 Moonshake day file 同款时间观
 *   24h    = B 逃生门：入队时刻（atMs）起 24h 滚动窗，不看 day
 *   tiered = C 逃生门：分级滚动窗——审批卡（等人裁决）72h、其余 24h
 *   （24h/tiered 的判定基准 spec 未细定义——以入队时刻为准，见施工报告缝账）
 *
 * 正典判定**无 fallback**：无 day 的存量条目在 day 模式下不按 today 计（施工读法 A 禁 B，
 * hui #1088——B 读法下 undefined 每天都被视为 today，day < today 恒假，存量卡永生）。
 * 存量条目走上线迁移一次性补打 day=部署日（tools/migrate-inbox-day.mjs，壳侧真钟）。
 */

import { nowJstDay } from "./orchestrator/day-clock.mjs";

export const TTL_MODES = ["day", "24h", "tiered"];

/** F2 过期 deny 的 decision actor（新枚举值，与人类/agent 并列——审计账与终态查询同认） */
export const EXPIRED_DECIDER = "system-expired";
/** F2 过期 deny 的落账 note（decide 形状里的说明行） */
export const EXPIRED_NOTE = "inbox TTL expired";

/**
 * 解析 CONDUCTOR_INBOX_TTL：合法三型原样返回；空/缺省 → "day"（方案 A 正典）；非法 → null。
 * 调用方纪律：conductor 常驻面对 null fail-fast（exit 1 + 出声）；彩排/单测面回 day + warn。
 */
export function parseTtlMode(raw) {
	const v = String(raw ?? "").trim();
	if (!v) return "day";
	return TTL_MODES.includes(v) ? v : null;
}

/**
 * 过期判定（纯函数）。entry 形状 { day?: string, atMs?: number, kind?: string }——runtime inbox
 * 条目（day/enqueuedAt/kind）与壳审批卡（day/createdAt→atMs、kind="审批卡"）共用同一判词。
 * @param {string} mode TTL_MODES 之一（day=正典）
 * @param {object} entry { day?, atMs?, kind? }
 * @param {Date|number} now 判定时钟（与写入同一座钟——注入位给单测，生产真钟）
 * @returns {boolean}
 */
export function ttlExpired(mode, { day, atMs, kind } = {}, now = new Date()) {
	const nowMs = now instanceof Date ? now.getTime() : Number(now);
	if (mode === "24h") return atMs != null && nowMs - atMs >= 24 * 3600_000;
	if (mode === "tiered") {
		const windowMs = kind === "审批卡" || kind === "审批" ? 72 * 3600_000 : 24 * 3600_000; // 审批等人裁决给长窗
		return atMs != null && nowMs - atMs >= windowMs;
	}
	// day（正典·方案 A）：自然日界，day < today 出队。无 day **不 fallback**（施工读法 A 禁 B）
	return typeof day === "string" && day < nowJstDay(nowMs);
}

/**
 * 清理记账行（spec 实现面 4/交付 7a）：「清了几条、逐条 id+类型」——死了的可追溯，半无痕不许。
 * @param {string} prefix 出声方标签（"[conductor]" / "[orch-runtime]"）
 * @param {Array<{id: string|number, kind?: string}>} swept 清理清单
 * @returns {string} 如 "[conductor] 收件箱按天清：2 条——#3(交货单) ap_xx(审批卡)"
 */
export function sweepAccountLine(prefix, swept) {
	const items = swept.map((s) => `${s.id}(${s.kind ?? "?"})`).join(" ");
	return `${prefix} 收件箱按天清：${swept.length} 条——${items}`;
}
