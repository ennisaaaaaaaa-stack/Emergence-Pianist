/**
 * day-clock.mjs — 日钟（JST 单点日判定）
 *
 * 是什么：JST（UTC+9）的「今天是哪天」——事件账按日翻篇的文件名（emit.mjs）与收件箱
 * 按天清理（F2）共用这一座钟（两把刀一套钟：写入与清理不许各看各的表）。纯函数、
 * 时钟注入、零 IO——判定与调用方各自的文件读写彻底解耦。
 */

/**
 * JST 日字符串（YYYY-MM-DD）。JST=UTC+9，日界比 UTC 早 9 小时（UTC 15:00 即 JST 次日零点）。
 * @param {Date|number} [now] 时钟注入（Date 或毫秒数；缺省真钟）
 * @returns {string} "YYYY-MM-DD"
 */
export function nowJstDay(now = new Date()) {
	const d = now instanceof Date ? now : new Date(now);
	return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}
