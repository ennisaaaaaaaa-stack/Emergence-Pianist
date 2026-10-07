// credentials/journal.mjs —— 凭证记账：只有名字没有值；写入前过 scanText（指纹兜底最后一道闸）。
// 事件字段：ts/agent(=pianist 或调用方显式指定，如沙箱工牌)/name/tier/action(list|status|use-broker|use-sandbox-broker|use-inject|write|destroy|meta|approval-request|approval-granted)。
// v2（T16）可选 context 字段：use 事件的「用在哪」（约定 <调用方>:<语境>，如 conductor:launch(wander)）——
// 只透传不造：调用方传了才落账，空串/undefined 一律不落（不许出现 "context":undefined 或空串污染账本）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanText } from "./scan.mjs";

export function journalPath() {
	return process.env.PORTALK_CRED_JOURNAL ?? fileURLToPath(new URL("../data/cred-journal.jsonl", import.meta.url));
}

/** 追加一条事件（fields 只放名字/档位/审批号等非值字段；note 类自由文本会被 scanText 洗）。
 *  fields.agent 可显式指定记账工牌（如沙箱路径传 policy.identity.agent）；不传走 PIANIST_AGENT/pianist 默认。
 *  fields.context 可选：use 语境透传（envOrVault 第三参 / inject --task / broker --task）。 */
export function journal(action, fields = {}) {
	const { agent, context, ...rest } = fields;
	const rec = { v: 1, ts: new Date().toISOString(), agent: agent ?? process.env.PIANIST_AGENT ?? "pianist", action, ...rest };
	if (typeof context === "string" && context.trim() !== "") rec.context = context; // 语境卫兵：空串不落账
	const line = scanText(JSON.stringify(rec));
	fs.mkdirSync(path.dirname(journalPath()), { recursive: true });
	fs.appendFileSync(journalPath(), line + "\n");
	return rec;
}
