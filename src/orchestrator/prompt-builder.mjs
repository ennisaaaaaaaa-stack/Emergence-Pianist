/**
 * prompt-builder.mjs — 分身 TASK prompt 构造器（任务编排器⑧ 第一铲·真身接线）
 *
 * 是什么：sheet + 角色 → per-minion 任务书 prompt（pi -p 的 TASK 正文），含指针解引用与审链模板。
 * 蓝图出处：EP-Orchestrator.md §3（指针规则：角色冷启动指针优先指事实表/spoor 档案，不贴正文）；
 * 拍板表#7（审链 v0：模板+占位符即交付，真跑第二铲）。
 *
 * 指针解引用纪律（fail-fast 不静默）：指针=可读路径则读出内容嵌进 prompt；
 * 不可读（不存在/非文件/读失败）→ 抛 PromptBuildError——静默出一份没有指针的 prompt
 * 等于让分身裸奔冷启动重新探明已探明的世界，那是失忆税，不是降级。
 *
 * N=1 特例与 N>1 都出对：数量>1 的角色，每个实例标明「第 i/N 个」（分工预声明 §3），
 * 避免同角色多分身互不知道彼此存在；N=1 不标（特例不说废话）。
 */

import fs from "node:fs";
import path from "node:path";

export class PromptBuildError extends Error {
	constructor(message) {
		super(message);
		this.name = "PromptBuildError";
	}
}

/**
 * 指针解引用：可读路径 → 内容；不可读 → fail-fast（不静默出无指针 prompt）。
 * 相对路径按 cwd 解析（任务书里的指针是仓内相对路径的习惯写法）。
 * @returns {{ resolvedPath: string, content: string }}
 */
export function dereferencePointer(pointer, { cwd = process.cwd() } = {}) {
	if (typeof pointer !== "string" || !pointer.trim()) {
		throw new PromptBuildError(`指针为空：${JSON.stringify(String(pointer))}（角色冷启动指针是必填形状，缺了要改书不是静默）`);
	}
	const resolvedPath = path.resolve(cwd, pointer.trim());
	let content = null;
	try {
		content = fs.readFileSync(resolvedPath, "utf8");
	} catch (err) {
		throw new PromptBuildError(
			`指针不可读：${pointer}（解析到 ${resolvedPath}，读取失败：${err?.code ?? err?.message}）——fail-fast，不出无指针 prompt 让分身裸奔冷启动`,
		);
	}
	if (content.length > 64_000) {
		// 指针该指结论层不是正文（§3）；超长说明指错了文件，出声不截断（截断=静默丢上下文）
		throw new PromptBuildError(`指针内容超长（${content.length}B > 64KB）：${pointer}——指针该指事实表/spoor 档案（结论层），不是贴正文`);
	}
	return { resolvedPath, content };
}

function bulletList(lines) {
	return (lines || []).map((l) => `- ${l}`).join("\n");
}

/**
 * 构造 per-minion TASK prompt。
 * @param {object} p
 * @param {object} p.sheet        parseCastingSheet 产物
 * @param {object} p.roleEntry    sheet.roles 里的角色条目（role/count/sandbox/pointer/acceptance）
 * @param {string} p.taskId
 * @param {string} p.minionId
 * @param {number} [p.index]      同角色第几个实例（1 起）
 * @param {string|null} [p.workaround]    已知坑重试注入（失败原因作重试输入 §6）
 * @param {string|null} [p.failureReason] 上一分身失败原因
 * @param {string} [p.cwd]        指针解析基目录
 * @returns {string} prompt 正文
 */
export function buildMinionPrompt({
	sheet, roleEntry, taskId, minionId,
	index = 1, workaround = null, failureReason = null, cwd = process.cwd(),
}) {
	if (!sheet || !roleEntry) throw new PromptBuildError("buildMinionPrompt 需要 sheet 与 roleEntry");
	const count = roleEntry.count ?? 1;
	const idx = Math.max(1, Number(index) || 1);

	const lines = [];
	lines.push(`# 任务：${sheet.name ?? taskId}`);
	lines.push(
		count > 1
			? `你是任务 ${taskId} 的「${roleEntry.role}」，分身id ${minionId}——同角色共 ${count} 个实例，你是第 ${idx} 个（分工见下，别做别人的那份）。`
			: `你是任务 ${taskId} 的「${roleEntry.role}」，分身id ${minionId}。`,
	);

	if (sheet.background) {
		lines.push("", "## 背景与边界", sheet.background);
	}

	// 冷启动指针：解引用嵌入（fail-fast 在 dereferencePointer 里）
	if (roleEntry.pointer) {
		const { resolvedPath, content } = dereferencePointer(roleEntry.pointer, { cwd });
		lines.push(
			"",
			"## 冷启动指针（先读这个再干活——已探明的世界不用重新探明）",
			`指针：${roleEntry.pointer}（${resolvedPath}）`,
			"<<<指针内容",
			content.trimEnd(),
			"指针内容>>>",
		);
	}

	const roleBits = [`角色：${roleEntry.role}`];
	if (count > 1) roleBits.push(`数量：${count}（你负责第 ${idx} 份）`);
	if (roleEntry.sandbox) roleBits.push(`沙箱：${roleEntry.sandbox}`);
	lines.push("", "## 你的角色", roleBits.join(" | "));
	if (roleEntry.acceptance) {
		lines.push("", "### 角色级验收", `- ${roleEntry.acceptance}`);
	}

	if (sheet.deliverables?.length) {
		lines.push("", "## 交付物清单", bulletList(sheet.deliverables));
	}
	if (sheet.acceptance?.length) {
		lines.push("", "## 验收标准", bulletList(sheet.acceptance));
	}
	if (sheet.disciplines?.length) {
		lines.push("", "## 纪律", bulletList(sheet.disciplines));
	}

	// 已知坑重试注入（§6 行3：workaround 注入，失败原因作重试输入）
	if (workaround || failureReason) {
		lines.push("", "## 重试注入（你是一次自动重试——上一个分身已死，死因是你的起点不是你的负担）");
		if (failureReason) lines.push(`- 失败原因：${failureReason}`);
		if (workaround) lines.push(`- workaround（照做）：${workaround}`);
	}

	lines.push(
		"",
		"## 收工协议",
		"- 全部做完且自验过：最后一个输出行必须是 `DONE`（单独一行）。",
		"- 任务书自相矛盾/歧义拿不准：输出 `BLOCKED:歧义: <一句话>`——你不当裁判，编排器停手转前台改书。",
		"- 环境缺（key/服务/工具不在场）：输出 `BLOCKED:环境: <缺什么>`——fail-fast，别绕。",
	);
	return lines.join("\n");
}

/**
 * 审链临时工任务书模板（拍板7：v0 模板+占位符即交付，真跑第二铲）。
 * 机械核对三件（蓝图 §5：临时工审=可清单化的那半，判断层在前台）：
 *   ① 源可达 ② 结论与引用对得上 ③ 测试真跑两遍（复验者≠施工者是结构不变式）。
 * 占位符约定：调用方不传的字段以 <占位说明> 字面量留在模板里——模板即交付物，
 * 占位符没填就派出去=审链空转，调用方自己负责（advisory 形状，不在此强制）。
 *
 * @param {object} p
 * @param {string} p.taskId      审链所属任务
 * @param {string} p.revieweeId  被审者分身id（复验者≠施工者，模板里点名）
 * @param {string} [p.subject]   被审对象（交付物清单/结论清单；缺省占位）
 * @param {string} [p.evidence]  证据指针（文件路径/引用来源；缺省占位）
 * @param {Array<string>} [p.claims] 被审结论逐条（缺省占位）
 */
export function buildReviewPrompt({ taskId, revieweeId, subject, evidence, claims } = {}) {
	const subj = subject ?? "<被审对象：交付物清单/结论清单——逐条列出>";
	const ev = evidence ?? "<证据指针：源文件路径/引用 URL 清单——逐条列出>";
	const cl = Array.isArray(claims) && claims.length ? bulletList(claims) : "- <被审结论逐条——占位>";
	return [
		`# 审链任务：${taskId}（机械复验）`,
		`你是审链临时工（分身id见环境），被审者是分身 ${revieweeId ?? "<revieweeId>"}——复验者≠施工者是结构不变式，你只做机械核对，不做「这活该不该这么干」的判断（那在前台）。`,
		"",
		"## 被审对象",
		subj,
		"",
		"## 证据指针",
		ev,
		"",
		"## 机械核对三件（只核这三件，别的红绿不由你判）",
		"1. 源可达：上面每条证据指针逐个打开/访问，不可达的逐条列出（源不可达=结论悬空）。",
		"2. 结论与引用对得上：被审结论逐条与引用原文比对——引用说了 A 结论写 A+ 就报红，别脑补。",
		"3. 测试真跑两遍：交付物挂的测试链自己完整跑两遍（不是看施工者自报的绿——施工者自报全绿不算数）。",
		"",
		"## 被审结论清单",
		cl,
		"",
		"## 阴性对照纪律",
		"审不动坏东西的审是绿灯盖章机：若施工者提供了「已知坏样本」，你必须先把坏样本审红，再信你对好样本的绿。",
		"",
		"## 收工协议",
		"- 全部核对完：最后一行输出 `VERDICT:pass` 或 `VERDICT:fail`（fail 必须在前文逐条列红项）。",
		"- 审链材料不可得（指针全空/占位符没填）：输出 `BLOCKED:环境: <缺什么>`——空转的审不如不出。",
	].join("\n");
}
