/**
 * review-chain.mjs —— 审链自动编排（10/16 收口：「零件全在·零调用方」的调用方）。
 *
 * 是什么：施工分身 DONE 后自动派审链分身（模型可配）——buildReviewPrompt（10/7 拍板7 的
 * 模板）从此有了真实调用方。审链分身独立 spawn、独立台账行，VERDICT:pass/fail 落收件箱。
 *
 * 设计纪律：
 *  - 复验者≠施工者是结构不变式：审链分身是独立进程，不共享施工者上下文。
 *  - 角色表里没配审链角色=不开审链（advisory 形状，任务书写「审链:角色名」才触发）。
 *  - 审链分身自己也是分身：双时钟、心跳源、审批上浮全套同样适用。
 *  - VERDICT 只有 pass/fail 两态；fail 时任务级处置归前台（主 agent/人），不自动重派。
 */

import { buildReviewPrompt } from "./prompt-builder.mjs";

export const REVIEW_TRIGGER = {
	/** 角色表声明位：施工角色行写「审链:评审员」→ 该角色交付后自动派同名角色的审链分身 */
	ROLE_FIELD: "review",
	ALIASES: ["审链", "review"],
};

/**
 * 从任务书角色表提取审链声明：{ 施工角色 → 审链角色 } 映射。
 * 约定：施工角色行写 `审链:评审员`，意思是「我交付后，派角色表里名为『评审员』的角色来审我」。
 */
export function extractReviewBindings(roles) {
	const byRole = new Map(roles.map((r) => [r.role, r]));
	const bindings = new Map(); // 施工角色 → 审链角色 entry
	for (const r of roles) {
		const reviewer = r[REVIEW_TRIGGER.ROLE_FIELD];
		if (!reviewer) continue;
		const revEntry = byRole.get(reviewer);
		if (!revEntry) {
			throw new Error(`角色表「${r.role}」声明审链:${reviewer}，但角色表里没有名为「${reviewer}」的角色`);
		}
		bindings.set(r.role, revEntry);
	}
	return bindings;
}

/**
 * 审链分身 prompt：buildReviewPrompt 模板 + 任务书验收段（审什么以书为准，不脑补）。
 * @param {object} p { sheet, revieweeId, revieweeRole, reviewEntry, taskId, deliverableManifest }
 */
export function buildReviewerPrompt({ sheet, revieweeId, revieweeRole, reviewEntry, taskId, deliverableManifest }) {
	const subject = [
		`被审角色：${revieweeRole}（分身 ${revieweeId}）`,
		"",
		"交付物清单（任务书声明）：",
		...(sheet.deliverables?.length ? sheet.deliverables.map((d) => `- ${d}`) : ["- <任务书未列>"]),
		"",
		"交货单 manifest（施工者自报——不可信，逐条验）：",
		...(deliverableManifest?.tail ? ["```", String(deliverableManifest.tail).slice(0, 3000), "```"] : ["- <无 manifest tail>"]),
	].join("\n");

	const evidence = [
		`任务书全文：见你的任务输入（验收标准以书为准）`,
		`工作目录：${sheet.cwd ?? process.cwd()}`,
	].join("\n");

	const claims = [
		`施工者自报 DONE（exit 0）`,
		deliverableManifest?.floorSummary ? `楼层摘要：${String(deliverableManifest.floorSummary).slice(0, 800)}` : `楼层摘要：无`,
	];

	return buildReviewPrompt({ taskId, revieweeId, subject, evidence, claims });
}
