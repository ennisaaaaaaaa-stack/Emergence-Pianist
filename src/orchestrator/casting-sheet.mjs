/**
 * casting-sheet.mjs — 任务编排器⑧ 施工铲1：casting sheet 解析器（蓝图 §3 v0 格式）
 *
 * 任务书 = 角色编排。统一格式：多分身大活必填角色表；单分身任务书是 N=1 特例，
 * 同样走角色表（不做旧格式兼容——格式不重发明，2026-10-06 蓝图定案）。
 *
 * 必填段：角色表 / 预算袋 / 验收标准。缺任一 → 解析拒绝并报具体缺什么（分身不当裁判，
 * 编排器也不当——书坏了要在门口拦，10/2 T7 教训）。
 * 预算袋：金额 / token / 时长 至少一项，逐笔记入台账归袋（§8）。
 *
 * 指针规则：角色冷启动指针优先指事实表/spoor 档案，不贴正文——解析器只持指针不解引用。
 */

export class CastingSheetError extends Error {
	constructor(message) {
		super(message);
		this.name = "CastingSheetError";
	}
}

/** 段名 → 规范键（含别名；交付物/验收的短名是书写习惯，解析归一） */
const SECTION_ALIASES = [
	["背景与边界", "background"],
	["预算袋", "budget"],
	["角色表", "roles"],
	["交付物清单", "deliverables"],
	["交付物", "deliverables"],
	["验收标准", "acceptance"],
	["验收", "acceptance"],
	["纪律", "disciplines"],
];
const HEADER_RE = new RegExp(
	`^(?:【\\s*)?(${SECTION_ALIASES.map((a) => a[0]).join("|")})(?:\\s*】)?\\s*[：:]?\\s*(.*)$`,
);
const REQUIRED_SECTIONS = ["角色表", "预算袋", "验收标准"];

const ROLE_KEY_MAP = {
	角色: "role", role: "role",
	数量: "count", count: "count",
	沙箱: "sandbox", sandbox: "sandbox",
	指针: "pointer", pointer: "pointer",
	验收: "acceptance", acceptance: "acceptance",
};

const DURATION_UNITS = {
	ms: 1, 毫秒: 1,
	s: 1000, 秒: 1000,
	m: 60_000, min: 60_000, 分钟: 60_000,
	h: 3_600_000, 小时: 3_600_000,
};

function parseDurationMs(text) {
	// 时长数值。裸数字按分钟解释（任务书人写习惯：时长 45 = 45 分钟）。
	const m = /([\d.]+)\s*(ms|毫秒|s|秒|m|min|分钟|h|小时)?/.exec(text);
	if (!m) return null;
	const n = Number(m[1]);
	if (!Number.isFinite(n) || n <= 0) return null;
	const unit = m[2] || "m";
	return n * (DURATION_UNITS[unit] ?? 60_000);
}

function parseBudget(lines) {
	const text = lines.join(" ");
	const budget = { raw: text.trim() };
	// 金额：$5 / 金额：5 美元 / ￥20
	const money = /(?:金额|money)\s*[：:=]?\s*([￥$])?\s*([\d,]+(?:\.\d+)?)/.exec(text);
	if (money) {
		budget.money = Number(money[2].replace(/,/g, ""));
		budget.currency = money[1] === "￥" ? "CNY" : "USD";
	}
	// token：token 200k / tokens: 200,000
	const tok = /tokens?\s*[：:=]?\s*([\d,]+(?:\.\d+)?)\s*(k|K|M)?/.exec(text);
	if (tok) {
		let n = Number(tok[1].replace(/,/g, ""));
		if (/^k$/i.test(tok[2] || "")) n *= 1000;
		if (/^M$/i.test(tok[2] || "")) n *= 1_000_000;
		budget.tokens = n;
	}
	// 时长：时长 45 分钟 / duration 25m
	const dur = /(?:时长|duration)\s*[：:=]?\s*([\d.]+\s*(?:ms|毫秒|s|秒|m|min|分钟|h|小时))/.exec(text);
	if (dur) {
		const ms = parseDurationMs(dur[1]);
		if (ms != null) budget.durationMs = ms;
	}
	return budget;
}

function parseRoleLine(line) {
	const parts = line.split("|").map((p) => p.trim()).filter(Boolean);
	const entry = {};
	for (const part of parts) {
		const idx = part.search(/[：:]/);
		if (idx < 0) continue;
		const key = ROLE_KEY_MAP[part.slice(0, idx).trim().toLowerCase()] || ROLE_KEY_MAP[part.slice(0, idx).trim()];
		if (!key) continue;
		entry[key] = part.slice(idx + 1).trim();
	}
	if (entry.count != null) {
		const n = Number(entry.count);
		if (!Number.isInteger(n) || n < 1) {
			throw new CastingSheetError(`角色表「${entry.role ?? "?"}」数量非法：${entry.count}（必须 ≥1 的整数）`);
		}
		entry.count = n;
	} else {
		entry.count = 1; // N=1 特例：省略数量即 1
	}
	return entry;
}

/**
 * 解析 casting sheet 文本 → 结构化任务书。
 * @throws {CastingSheetError} 缺必填段 / 角色表为空 / 预算袋三项全空 —— 报具体缺什么。
 */
export function parseCastingSheet(text) {
	if (typeof text !== "string" || !text.trim()) {
		throw new CastingSheetError("任务书为空或非文本——解析拒绝");
	}
	const lines = text.split(/\r?\n/).map((l) => l.trimEnd());

	const sheet = {
		name: null, background: "", budget: null,
		roles: [], deliverables: [], acceptance: [], disciplines: [],
	};

	// 标题：首个 # 行
	for (const line of lines) {
		const m = /^#\s+(.+?)\s*$/.exec(line.trim());
		if (m) { sheet.name = m[1]; break; }
	}

	// 分段
	const sections = new Map(); // 规范键 → 行数组
	let current = null;
	for (const raw of lines) {
		const line = raw.trim();
		if (!line) continue;
		const m = HEADER_RE.exec(line);
		if (m) {
			const canonical = SECTION_ALIASES.find((a) => a[0] === m[1])[1];
			if (!sections.has(canonical)) sections.set(canonical, []);
			current = canonical;
			if (m[2] && m[2].trim()) sections.get(canonical).push(m[2].trim());
			continue;
		}
		if (current) sections.get(current).push(line);
	}

	// 必填段检查：一次报全缺什么（分身不当裁判，编排器替它把话说明白）
	const missing = REQUIRED_SECTIONS.filter((name) => {
		const canonical = SECTION_ALIASES.find((a) => a[0] === name)[1];
		return !sections.has(canonical) || sections.get(canonical).length === 0;
	});
	if (missing.length) {
		throw new CastingSheetError(`任务书缺必填段：${missing.join("、")}`);
	}

	sheet.background = (sections.get("background") || []).join("\n").trim();
	sheet.deliverables = (sections.get("deliverables") || []).map((l) => l.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
	sheet.acceptance = (sections.get("acceptance") || []).map((l) => l.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
	sheet.disciplines = (sections.get("disciplines") || []).map((l) => l.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);

	// 预算袋：金额/token/时长 至少一项
	sheet.budget = parseBudget(sections.get("budget") || []);
	if (sheet.budget.money == null && sheet.budget.tokens == null && sheet.budget.durationMs == null) {
		throw new CastingSheetError("预算袋为空——金额/token/时长至少一项（逐笔记入台账归袋）");
	}

	// 角色表：每行一个角色条目（pipe 分隔 k:v）
	const roleLines = (sections.get("roles") || []).map((l) => l.replace(/^[-*•]\s*/, "").trim()).filter(Boolean);
	if (!roleLines.length) throw new CastingSheetError("角色表为空——至少一行角色条目");
	for (const rl of roleLines) {
		const entry = parseRoleLine(rl);
		if (!entry.role) throw new CastingSheetError(`角色表条目缺「角色」名：${rl}`);
		sheet.roles.push(entry);
	}

	return sheet;
}
