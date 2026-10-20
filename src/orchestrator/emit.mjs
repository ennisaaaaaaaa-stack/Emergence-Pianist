/**
 * emit.mjs — 存在感事件账（F3 收窄版，spec：docs/f3-emit-hook-spec-v0.2.md）
 *
 * 是什么：编排器在关键节点对外发心跳事件的唯一落账面——append 一行 JSON 到
 * <eventsDir>/emit-<date>.jsonl（date 走 day-clock 的 JST 单点日，按日翻篇从第一行
 * 起就是正典，无单文件过渡态）。事件形状 { v:1, ts, kind, source:"orchestrator", data }：
 * 机械心跳不是消息，谁想听谁 tail 当日文件（推hearth推桌面是消费方的事，本层只管发生）。
 * 拔插头纪律：写失败（任何异常）console.warn 出声后吞掉，绝不抛——事件账死了主流程照跑。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { nowJstDay } from "./day-clock.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EVENTS_DIR = path.resolve(__dirname, "..", "..", "data", "events"); // repo 相对解析，不硬编码绝对路径

/**
 * 发一条存在感事件（append-only 旁路账）。
 * @param {string} kind 事件种类（dispatch.started / dispatch.exited / verdict.received / watchman.judged / escalation.human）
 * @param {object} data 识别键载荷（minionId/taskId/verdict 等——心跳只带身份键，不带正文）
 * @param {object} [opts]
 * @param {string} [opts.eventsDir] 事件目录（缺省 repo 相对 data/events；测试隔离注入位）
 * @param {Date|number} [opts.now] 时钟注入（注钟跨日验按日翻篇用；缺省真钟）
 * @param {object} [opts.fs] fs 注入位（阴性对照：注入抛错实现验「死了不拦主流程」）
 */
export function emitEvent(kind, data, opts = {}) {
	try {
		const f = opts.fs ?? fs;
		const now = opts.now instanceof Date ? opts.now : new Date();
		const dir = opts.eventsDir ?? DEFAULT_EVENTS_DIR;
		const file = path.join(dir, `emit-${nowJstDay(now)}.jsonl`);
		const line = JSON.stringify({ v: 1, ts: now.toISOString(), kind, source: "orchestrator", data }) + "\n";
		f.mkdirSync(dir, { recursive: true });
		f.appendFileSync(file, line);
	} catch (err) {
		console.warn(`[orch-emit] 事件账写失败（不拦主流程）：kind=${kind} — ${err?.message ?? err}`);
	}
}
