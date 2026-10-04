// credentials/journal.mjs —— 凭证记账：只有名字没有值；写入前过 scanText（指纹兜底最后一道闸）。
// 事件字段：ts/agent(=pianist 或调用方显式指定，如沙箱工牌)/name/tier/action(list|use-broker|use-sandbox-broker|use-inject|write|destroy|approval-request|approval-granted)。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanText } from "./scan.mjs";

export function journalPath() {
	return process.env.PORTALK_CRED_JOURNAL ?? fileURLToPath(new URL("../data/cred-journal.jsonl", import.meta.url));
}

/** 追加一条事件（fields 只放名字/档位/审批号等非值字段；note 类自由文本会被 scanText 洗）。
 *  fields.agent 可显式指定记账工牌（如沙箱路径传 policy.identity.agent）；不传走 PIANIST_AGENT/pianist 默认。 */
export function journal(action, fields = {}) {
	const { agent, ...rest } = fields;
	const rec = { v: 1, ts: new Date().toISOString(), agent: agent ?? process.env.PIANIST_AGENT ?? "pianist", action, ...rest };
	const line = scanText(JSON.stringify(rec));
	fs.mkdirSync(path.dirname(journalPath()), { recursive: true });
	fs.appendFileSync(journalPath(), line + "\n");
	return rec;
}
