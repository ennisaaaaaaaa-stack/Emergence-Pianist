/**
 * skill-gate.mjs — 自学习闭环 v2 第一铲：入库前机械校验（四道闸，全零 LLM）
 *
 * 背景：砍 shadow 试用期，candidate 直入山海 draft 区（status=draft，山海机制不改），
 * 质量靠「入库前机械校验 + 入库后使用数据淘汰」。本文件是入库前那半边。
 *
 * 边界（zhaozhao拍板，不自行放宽）：
 *   - 四道闸只对 name 以 "auto/" 前缀命名的提交生效；非 auto/ 名字全跳过——
 *     非 auto 走 red 人工审批面，人眼兜底（retropad 现有提交零影响）
 *   - 判而不剪：校验器只打回+给理由，不改写提交内容（纯函数无副作用）
 *   - 打回必须带逐条人话 reasons——打回不是静默丢弃（遥测丢失必须出声的同族纪律）
 *
 * 提案：EP-自学习闭环v2（Emergence-Pianist）；山海契约见 /root/Agent-Grimoire grimoire.py post_skill
 */

// ---------------------------------------------------------------------------
// 前缀判断
// ---------------------------------------------------------------------------

/** auto/ 前缀判断：山海侧无 auto/ 机制，这是纯命名约定（已定案不重开）。
 *  name 先 trim 再比——山海入库前自己会 strip name，两侧对齐同一把尺子 */
export function isAutoSubmission(payload) {
	const name = typeof payload?.name === "string" ? payload.name.trim() : "";
	return name.startsWith("auto/");
}

// ---------------------------------------------------------------------------
// 闸二：消毒正则表（零 LLM——形状匹配，不猜语义）
// ---------------------------------------------------------------------------

/** 秘密形状表：命中即打回，理由带回命中片段（截 40 字，够人眼定位不够复用） */
const SECRETS_RES = [
	{ re: /AKIA[A-Z0-9]{16,}/, label: "AWS Access Key 形状" },
	{ re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: "私钥块（PEM 头）" },
	{ re: /sk-[A-Za-z0-9]{20,}/, label: "OpenAI API Key 形状" },
	{ re: /ghp_[A-Za-z0-9]{30,}/, label: "GitHub Token 形状" },
	{ re: /\/root\//, label: "/root/ 绝对路径" },
];

/** 四道闸常量：闸三的修剪纪律原文（理由里原样带给提交者自己剪） */
const TRIGGER_PRUNE_DISCIPLINE = "1-3 全留 / 4 留 3 / ≥5 只留 4";

// ---------------------------------------------------------------------------
// 主校验：纯函数，无副作用，零 LLM
// ---------------------------------------------------------------------------

/**
 * validateSkillSubmission(payload) → { ok: true } | { ok: false, reasons: string[] }
 *
 * 四道闸（只对 auto/ 前缀生效）：
 *   闸一 格式：tags 非空数组、body 非空、trigger 非空
 *   闸二 消毒：body+trigger+boundary+why 拼接过秘密形状正则表，命中即打回
 *   闸三 触发词：trigger 按空白切词 N≥5 打回（判而不剪——纪律写给提交者自己剪）
 *   闸四 反例：control_case 非空（语义相近但不该触发的反例文本；v0 只验存在性，
 *              语义比对是后续复盘分身的活）
 *
 * 非 auto/ 名字：{ ok: true } 直接过——red 人工审批面人眼兜底
 */
export function validateSkillSubmission(payload) {
	if (!isAutoSubmission(payload)) return { ok: true };
	const p = payload ?? {};
	const reasons = [];

	// ---- 闸一 格式 ----
	const tags = p.tags;
	if (!Array.isArray(tags) || tags.length === 0) {
		reasons.push("闸一 格式：tags 需为非空数组（auto/ 提交必须至少挂一个山系 tag）");
	}
	if (typeof p.body !== "string" || p.body.trim() === "") {
		reasons.push("闸一 格式：body 不能为空（auto/ 提交必须有正文）");
	}
	if (typeof p.trigger !== "string" || p.trigger.trim() === "") {
		reasons.push("闸一 格式：trigger 不能为空（auto/ 提交必须写触发词）");
	}

	// ---- 闸二 消毒：四字段拼接过形状表 ----
	const text = [p.body, p.trigger, p.boundary, p.why]
		.map((x) => (typeof x === "string" ? x : ""))
		.join("\n");
	for (const { re, label } of SECRETS_RES) {
		const hit = text.match(re);
		if (hit) {
			reasons.push(`闸二 消毒：命中 ${label}（片段：${String(hit[0]).slice(0, 40)}）——skill 正文不许带秘密/绝对路径形状`);
		}
	}

	// ---- 闸三 触发词长度：判而不剪 ----
	if (typeof p.trigger === "string") {
		const words = p.trigger.trim().split(/\s+/).filter(Boolean);
		if (words.length >= 5) {
			reasons.push(
				`闸三 触发词过多：trigger 切词 N=${words.length}（≥5 打回）。修剪纪律「${TRIGGER_PRUNE_DISCIPLINE}」——自己剪完重提，校验器判而不剪`
			);
		}
	}

	// ---- 闸四 control case：v0 只验存在性 ----
	if (typeof p.control_case !== "string" || p.control_case.trim() === "") {
		reasons.push("闸四 反例缺失：control_case 不能为空（写一段语义相近但不该触发本 skill 的反例文本，v0 只验存在性）");
	}

	return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
