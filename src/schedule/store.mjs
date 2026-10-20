/**
 * store.mjs — schedule 存储层（2026-10-12 schedule-bone 施工）
 *
 * 是什么：data/schedule/schedule.json 的读写面——读侧容错（缺文件=空表不是错误：全新部署
 * 没排过日程是常态；坏 JSON=出声+空表，接缝不叠加崩），写侧保字段（读什么写什么，不认识的
 * 顶层字段原样带过——评估器只认它认识的，前端可视化未来要吃的结构化数据不许被存储层削掉）。
 *
 * 条目形状（spec §四拍板⑤）：{ id, window: {start, end}, part, params, intent, created_by,
 * status }——消费侧另有可选 permission（条目级档位钉死）/ fired_at / skipped_at / fail_reason
 *（评估器/接线写的账）。写路径只做 JSON 落盘，不做业务判断——判断全在 evaluator.mjs。
 *
 * 活动窗文件（active-hours.json）：{ activeHours: "HH:MM-HH:MM" }——agent 自适应的调整通道
 *（后续活），env CONDUCTOR_ACTIVE_HOURS 优先于它。读侧只回字符串原文，解析在 evaluator。
 */

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PERMISSION_TIER, DEFAULT_ENTRY_STATUS } from "./evaluator.mjs";

/** 空表形状（缺文件/坏 JSON 的回落值） */
export function emptySchedule() {
	return { v: 1, default_permission: DEFAULT_PERMISSION_TIER, entries: [] };
}

/**
 * 读日程表：缺文件 → 空表（静默——没排过日程是常态）；坏 JSON / 非对象 → 出声 + 空表
 *（拉不到 ≠ 没有，但坏文件修在人：出声不猜）。文件在且形状对 → 原样返回（缺字段由
 * 消费侧各自容错：evaluator 对 default_permission/entries 缺失均有回落）。
 */
export function readSchedule(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (e?.code === "ENOENT") return emptySchedule();
		console.warn(`[schedule] 日程表读取失败（当空表）：${file}——${e?.message ?? e}`);
		return emptySchedule();
	}
	try {
		const j = JSON.parse(raw);
		if (!j || typeof j !== "object" || Array.isArray(j)) {
			console.warn(`[schedule] 日程表形状不对（当空表）：${file}——顶层不是对象`);
			return emptySchedule();
		}
		if (!Array.isArray(j.entries)) {
			console.warn(`[schedule] 日程表 entries 非数组（当空表消费，写回前须人修）：${file}`);
			return emptySchedule();
		}
		return j;
	} catch (e) {
		console.warn(`[schedule] 日程表 JSON 坏（当空表）：${file}——${e?.message ?? e}（半截写入？修文件别丢数据）`);
		return emptySchedule();
	}
}

/** 写日程表：mkdir -p + JSON 落盘（同 conductor saveState 的 writeFileSync 口径）。 */
export function writeSchedule(file, sched) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(sched, null, 2) + "\n");
	return sched;
}

/**
 * 活动窗文件读侧：{ activeHours: "HH:MM-HH:MM" } → 字符串原文；缺文件/坏 JSON/字段非字符串
 * → null（evaluator 双通道里 null=该通道缺席，回落 env → 默认值）。坏 JSON 出声，缺文件静默。
 */
export function readActiveHoursFile(file) {
	let raw;
	try {
		raw = fs.readFileSync(file, "utf8");
	} catch (e) {
		if (e?.code === "ENOENT") return null;
		console.warn(`[schedule] 活动窗文件读取失败（当缺席）：${file}——${e?.message ?? e}`);
		return null;
	}
	try {
		const j = JSON.parse(raw);
		if (typeof j?.activeHours === "string") return j.activeHours;
		console.warn(`[schedule] 活动窗文件缺 activeHours 字符串字段（当缺席）：${file}`);
		return null;
	} catch (e) {
		console.warn(`[schedule] 活动窗文件 JSON 坏（当缺席）：${file}——${e?.message ?? e}`);
		return null;
	}
}

/** 造一条目（测试/排班工具用速记；消费侧不依赖它——文件里的裸条目照常评估） */
export function makeEntry({ id, window, part, params, intent, created_by = "agent", status = DEFAULT_ENTRY_STATUS, permission }) {
	return { id, window, part, params, intent, created_by, status, ...(permission ? { permission } : {}) };
}
