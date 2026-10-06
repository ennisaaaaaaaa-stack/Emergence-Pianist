/**
 * obituary.mjs — 讣告生成器（任务编排器⑧ 施工铲6，蓝图 §4.3 死亡闭环）
 *
 * 大多数 runtime 没做的那块：分身死掉无人知晓、还要主agent 自己去查，是要消灭的形状。
 * 判活三源机械化（手工版：10/2 推送中断那次的审计）：
 *   1. 遥测流（第一源，静默≠死）
 *   2. pi 会话原文（第二源，工具调用+结果+文本完整）
 *   3. 账本收据（append-only 内核不变量——没有账本就没有验尸材料）
 *
 * 缺源必须降级出声：讣告里写明哪个源缺失（missingSources），不许装全知——
 * 遥测缺了就不出地板摘要（死掉的分身写不了自己的摘要，讣告只吃地板数据）。
 *
 * 死因判定枚举（蓝图 §4.3）：超时 / 环境 / 自杀（session 死亡·非硬停）。
 */

import { floorSummaryFromEvents } from "./floor-summary.mjs";

export const DEATH_CAUSES = ["超时", "环境", "自杀"];
export const SOURCE_LABELS = {
	telemetryEvents: "遥测源",
	sessionText: "会话原文源",
	receipts: "账本收据源",
};

const NEXT_STEP = {
	超时: "走 T10 协议读会话原文判『干完没跑完』；地板若显示接近完成（文件已写/测试已绿），可手动续跑收尾而非重派。",
	环境: "补齐缺失环境（见死因明细）后重派——同任务自动重试 ≤1 次，失败原因作重试输入。",
	自杀: "读会话原文尾部定位自因（self-exit/崩溃/工具误伤）；salvage 已清点，判断层决定续跑、改书还是放弃。",
};

function sessionTail(sessionText) {
	if (typeof sessionText !== "string" || !sessionText.trim()) return null;
	const lines = sessionText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const tail = lines.slice(-3).join(" | ");
	return tail.length > 300 ? tail.slice(-300) : tail;
}

/**
 * 生成讣告。sources 三源各自可选；缺哪个，missingSources 里点名哪个。
 * @param {object} p
 * @param {object} p.minion        台账行（id/role/sheetId/startedAt/cost/...）
 * @param {'超时'|'环境'|'自杀'} p.cause
 * @param {string} p.causeDetail   死因明细（环境缺什么/哪口钟触发/自因线索）
 * @param {object} p.sources       { telemetryEvents?: event[], sessionText?: string, receipts?: [{amount, note}] }
 */
export function generateObituary({ minion, cause, causeDetail = "", sources = {} }) {
	if (!DEATH_CAUSES.includes(cause)) throw new Error(`讣告非法死因：${cause}（合法：${DEATH_CAUSES.join("/")}）`);

	const missingSources = [];
	for (const key of Object.keys(SOURCE_LABELS)) {
		if (sources[key] == null) missingSources.push(SOURCE_LABELS[key]);
	}

	// 地板只吃遥测：遥测源缺 → 地板为 null，明确降级出声，绝不编造
	let floor = null;
	if (sources.telemetryEvents != null) floor = floorSummaryFromEvents(sources.telemetryEvents);

	// salvage 清单：机械可证的部分——碰过的文件 + 测试状态 + 会话尾部线索
	const salvage = {
		filesTouched: floor ? floor.filesTouched : [],
		testStatus: floor ? floor.testStatus : "unknown（遥测源缺失，不可知）",
		lastEventTs: floor ? floor.lastEventTs : null,
		sessionTail: sessionTail(sources.sessionText),
		notes: [],
	};
	if (!floor) salvage.notes.push("遥测源缺失——地板摘要不可用，已产出清点仅凭会话原文/账本收据。");
	if (sources.sessionText == null) salvage.notes.push("会话原文源缺失——死前最后现场不可还原。");

	// 花费：账本收据优先（查证），缺则用台账行自记，再缺就出声
	let cost = null;
	let costBasis = null;
	if (Array.isArray(sources.receipts)) {
		cost = sources.receipts.reduce((s, r) => s + (Number(r?.amount) || 0), 0);
		costBasis = "账本收据合计";
	} else if (minion?.cost != null) {
		cost = minion.cost;
		costBasis = "台账行自记（账本收据源缺失，未经查证）";
	} else {
		costBasis = "花费未知（无账本收据、台账行无记）";
	}

	const obituary = {
		minionId: minion?.id ?? null,
		role: minion?.role ?? null,
		sheetId: minion?.sheetId ?? null,
		cause,
		causeDetail,
		startedAt: minion?.startedAt ?? null,
		cost,
		costBasis,
		salvage,
		floorSummary: floor,
		nextStep: NEXT_STEP[cause],
		missingSources,
		degraded: missingSources.length > 0,
	};
	return obituary;
}

/** 人话渲染（盯场/送达用；结构体给机器，这版给前台） */
export function renderObituary(o) {
	const lines = [
		`── 讣告：${o.minionId}（${o.role ?? "?"}，书=${o.sheetId ?? "?"}）──`,
		`死因：${o.cause}${o.causeDetail ? `——${o.causeDetail}` : ""}`,
		`花费：${o.cost ?? "?"}（${o.costBasis}）`,
	];
	if (o.salvage.filesTouched.length) lines.push(`已产出 salvage：${o.salvage.filesTouched.join("、")}`);
	else lines.push("已产出 salvage：无文件级产出可证");
	lines.push(`测试状态：${o.salvage.testStatus}`);
	if (o.salvage.sessionTail) lines.push(`会话尾部：${o.salvage.sessionTail}`);
	if (o.missingSources.length) lines.push(`⚠ 降级（缺源出声，不装全知）：${o.missingSources.join("、")} 缺失`);
	lines.push(`下一步建议：${o.nextStep}`);
	return lines.join("\n");
}
