/**
 * floor-summary.mjs — 心跳地板·确定性摘要（任务编排器⑧ 施工铲7，蓝图 §4.2 地板）
 *
 * 零 LLM、零 token：从遥测事件流机械抽取——当前工具、碰过的文件、测试红绿、
 * 最后事件时间戳。任何分身任何时刻都有，**死掉的也有**（讣告只吃地板数据，
 * 因为死掉的分身写不了自己的楼层摘要）。
 *
 * 输入契约：遥测 v1 事件（extensions/pianist-tools.ts 落盘形状）
 *   { v:1, ts: ISO, agent, kind: 'tool_use'|'message_end'|..., data: { tool, input, isError, ... } }
 * 坏行跳过并计数（遥测流截尾是常态，地板不许因一行坏数据拒出）。
 */

import fs from "node:fs";

const TEST_RUNNER_RE = /\b(npm\s+test|npm\s+run\s+test|npx\s+(?:vitest|jest)|\bvitest\b|\bjest\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b)/;

/** 从工具调用 input 里机械抽文件路径（文件形工具；bash 的文件面不可机械知，不猜） */
function filePathFromInput(tool, input) {
	if (!input || typeof input !== "object") return null;
	if (typeof input.path === "string" && input.path) return input.path;
	if (tool === "edit" && Array.isArray(input.edits)) {
		// edit 多块只记主 path，不展开（地板要一行能读的）
		return input.path ?? null;
	}
	return null;
}

export function floorSummaryFromEvents(events) {
	const files = new Set();
	let currentTool = null;
	let lastEventTs = null;
	let toolCallCount = 0;
	let badLines = 0;
	const testRuns = [];

	for (const ev of events) {
		if (!ev || typeof ev !== "object" || !ev.ts) { badLines++; continue; }
		lastEventTs = ev.ts;
		if (ev.kind !== "tool_use" || !ev.data) continue;
		toolCallCount++;
		const tool = ev.data.tool ?? null;
		if (tool) currentTool = tool;
		const input = ev.data.input ?? {};
		const p = filePathFromInput(tool, input);
		if (p) files.add(p);
		if (tool === "bash" && typeof input.command === "string" && TEST_RUNNER_RE.test(input.command)) {
			testRuns.push({ ts: ev.ts, command: input.command, ok: ev.data.isError !== true });
		}
	}

	const lastRun = testRuns.length ? testRuns[testRuns.length - 1] : null;
	return {
		currentTool,
		filesTouched: [...files].sort(),
		testStatus: lastRun ? (lastRun.ok ? "green" : "red") : "unknown",
		testRunCount: testRuns.length,
		lastTestCommand: lastRun?.command ?? null,
		lastEventTs,
		toolCallCount,
		badLines,
	};
}

/** 从 jsonl 文件读遥测流出地板摘要（fixture/真实落盘同形状） */
export function floorSummaryFromFile(file) {
	if (!fs.existsSync(file)) return floorSummaryFromEvents([]);
	const text = fs.readFileSync(file, "utf8");
	const events = [];
	for (const line of text.split("\n")) {
		const t = line.trim();
		if (!t) continue;
		try { events.push(JSON.parse(t)); } catch { /* 坏行计入 badLines */ events.push(null); }
	}
	return floorSummaryFromEvents(events);
}
