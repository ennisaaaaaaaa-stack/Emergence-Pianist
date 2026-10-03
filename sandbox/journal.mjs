// sandbox/journal.mjs —— 先通后报记账（最小版：jsonl append，与其他 data/*.jsonl 同风格）
// 每个白名单外新端点首次放行时落一行：ts/agent/host/scope/note（v 字段对齐 telemetry 风格）。
import fs from "node:fs";
import path from "node:path";

/** 追加一行记账。返回落账的记录对象。 */
export function appendJournalLine(journalPath, { agent, host, scope, note }) {
	const rec = { v: 1, ts: new Date().toISOString(), agent, host, scope, note };
	fs.mkdirSync(path.dirname(journalPath), { recursive: true });
	fs.appendFileSync(journalPath, JSON.stringify(rec) + "\n");
	return rec;
}

/** 读现有行数（测试用：跑之前/之后对比）。文件不存在返回 0。 */
export function countJournalLines(journalPath) {
	try {
		return fs.readFileSync(journalPath, "utf8").split("\n").filter((l) => l.trim()).length;
	} catch {
		return 0;
	}
}
