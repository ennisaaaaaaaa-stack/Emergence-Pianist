// credentials/tiers.mjs —— 审批分层：standing（常设预授权，订阅型）/ task（任务级，任务书点名即批）
// / per-use（逐次+复盘）。默认无配置=拒绝使用并出声（不是静默）。
// 审批卡片对齐 src/queue-core.mjs ApprovalQueue 的既有形状（ap_<ts>_<seq>、status pending|executed|denied、
// decidedBy/note）；真实流的「等待审批」接缝=壳的 /approvals 通道 + notify 环（见 conductor/shell），本模块
// 留 decider 钩子，测试里用 stub，不新发明协议。
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { journal } from "./journal.mjs";

const DEFAULT_TIERS = fileURLToPath(new URL("./tiers.json", import.meta.url));

export function tiersPath() {
	return process.env.PORTALK_CRED_TIERS ?? DEFAULT_TIERS;
}

export function loadTiers() {
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(tiersPath(), "utf8"));
	} catch (e) {
		if (e.code === "ENOENT") return { standing: [], task: [], "per-use": [] };
		throw new Error(`tiers.json 解析失败：${e.message}`);
	}
	return {
		standing: (raw.standing ?? []).map(String),
		task: (raw.task ?? []).map(String),
		"per-use": (raw["per-use"] ?? []).map(String),
	};
}

/** 查决定（纯查表，不产生事件）：{ name, tier, allowed, reason }。 */
export function check(name) {
	const t = loadTiers();
	let tier = null;
	for (const k of ["standing", "task", "per-use"]) if (t[k].includes(name)) tier = k;
	if (tier === "standing" || tier === "task") return { name, tier, allowed: true, reason: `${tier} 档预授权` };
	if (tier === "per-use") return { name, tier, allowed: false, reason: "per-use 档：需逐次审批" };
	return { name, tier: null, allowed: false, reason: `钥匙 ${name} 无审批配置：默认拒绝（出声），需要时写进 credentials/tiers.json` };
}

let approvalSeq = 0;
const items = new Map(); // id → 审批卡片（进程内，与 ApprovalQueue 同生命周期语义）

/** per-use 审批请求：落 approval-request 事件，返回审批卡片（对齐 ApprovalQueue.request 形状，只有名字没有值）。 */
export function requestApproval(name, { intent = null } = {}) {
	const item = {
		id: `ap_${Date.now().toString(36)}_${++approvalSeq}`,
		action: "credential_use",
		agent: process.env.PIANIST_AGENT ?? "pianist",
		name,
		summary: `逐次审批：使用钥匙 ${name}${intent ? `（${intent}）` : ""}`,
		tier: "per-use",
		status: "pending", // pending | executed | denied
		createdAt: new Date().toISOString(),
		decidedAt: null,
		decidedBy: null,
		note: null,
	};
	items.set(item.id, item);
	journal("approval-request", { name, tier: "per-use", approvalId: item.id });
	return item;
}

/** 裁决：批准 → journal approval-granted；驳回 → 只改状态不落 granted。幂等冲突返回 null。 */
export function decide(id, approve, by = "human", note = null) {
	const item = items.get(id);
	if (!item || item.status !== "pending") return null;
	item.status = approve ? "executed" : "denied";
	item.decidedAt = new Date().toISOString();
	item.decidedBy = by;
	item.note = note;
	if (approve) journal("approval-granted", { name: item.name, tier: "per-use", approvalId: id, by: item.decidedBy });
	return item;
}

/** 使用前统一闸：standing/task 直接放行；per-use 发审批请求交给 decider（真实流=壳审批通道，测试=stub）；
 *  无 decider 时挂起出声拒绝，不静默。 */
export async function authorize(name, { intent = null, decider = null } = {}) {
	const c = check(name);
	if (c.allowed) return { ...c, approval: null };
	if (c.tier === null) return { ...c, approval: null }; // 无配置：出声拒绝（reason 由调用方打印）
	const item = requestApproval(name, { intent });
	if (!decider) {
		return { ...c, allowed: false, reason: `${c.reason}（审批 ${item.id} 已挂起，等待人工裁决）`, approval: item };
	}
	const verdict = await decider(item);
	const done = decide(item.id, !!(verdict && verdict.approve), verdict?.by ?? "human", verdict?.note ?? null);
	return {
		...c,
		allowed: !!(done && done.status === "executed"),
		reason: done?.status === "executed" ? "per-use 档已批准" : "per-use 档被驳回",
		approval: done ?? item,
	};
}
