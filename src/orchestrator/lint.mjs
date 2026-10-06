/**
 * lint.mjs — 任务书 lint（任务编排器⑧ 施工铲2，蓝图 §3；预检形状参照 omc lookout）
 *
 * advisory only：只报 findings，不自动改书。两条 v0 规则：
 *   1) 纪律段与交付物冲突（10/2 T7 教训：任务书自相矛盾逼分身当裁判）
 *      ——文本模式：纪律「只动 X」与交付物清单含 X 之外的文件 → high。
 *   2) 交付物挂 npm test 链 → 硬停时长预估提醒（T10 教训：25min 掐在最后一公里）→ medium。
 *
 * 退出码纪律：0=干净 / 1=严格模式见高危 / 2=lint 自身用法错
 *   ——lint 坏了要出声，不是静默放行。
 */

import { parseCastingSheet } from "./casting-sheet.mjs";

/** 纪律「只动 X」的目标提取（启发式文本模式，advisory） */
const ONLY_PATTERNS = [
	/只(?:能)?(?:动|改|许改|触碰|写)(?:到|进|在)?\s*[「'"（(]?\s*([^」'"）)，。；、,;]+)/,
	/仅(?:动|改|触碰|写)(?:到|进|在)?\s*[「'"（(]?\s*([^」'"）)，。；、,;]+)/,
];

/** 只有长得像路径的目标才参与冲突判定（防把「只动 src 下的文件」这种人话误判成路径） */
const KNOWN_ROOTS = ["src", "test", "docs", "tools", "extensions", "data", "deploy", "sandbox", "credentials"];
function isPathLike(t) {
	t = t.trim().replace(/\/+$/, "");
	if (t.startsWith("./") || t.startsWith("/") || t.includes("/")) return true;
	return KNOWN_ROOTS.includes(t.split(/[/\\]/)[0]) && !t.includes(/\s/);
}

/** 从交付物/验收行里抽路径形 token */
const PATH_TOKEN_RE = /[\w.@-]+\/[\w.@/-]+|\b[\w-]+\.(?:mjs|cjs|js|ts|tsx|md|json|sh|py|txt|yaml|yml)\b/g;
function extractPaths(lines) {
	const out = new Set();
	for (const line of lines) {
		for (const m of line.matchAll(PATH_TOKEN_RE)) {
			const tok = m[0];
			if (/^(npm|node|git|http|https|com|www)$/i.test(tok)) continue;
			out.add(tok.replace(/^\.\//, ""));
		}
	}
	return [...out];
}

function under(target, path) {
	const t = target.replace(/\/+$/, "").replace(/\/\*$/, "");
	const p = path.replace(/^\.\//, "");
	return p === t || p.startsWith(t + "/");
}

/**
 * lint 一份已解析的任务书。
 * @returns {Array<{rule, severity: 'high'|'medium', message, evidence?}>}
 */
export function lintSheet(sheet) {
	const findings = [];
	const deliverablePaths = extractPaths(sheet.deliverables);

	// 规则1：纪律「只动 X」× 交付物路径冲突
	for (const line of sheet.disciplines) {
		for (const re of ONLY_PATTERNS) {
			const m = re.exec(line);
			if (!m) continue;
			// 目标可能并列（src/a 和 src/b、或分隔），逐个拆；只取每个备选的头部路径 token
			// （「只动 src/orchestrator/ 下的文件」的目标是目录，不是整句人话）
			const targets = m[1].split(/和|及|与|\+/).map((t) => {
				const tok = /^([^\s，。；,;]+)/.exec(t.trim());
				return tok ? tok[1] : "";
			}).filter(isPathLike);
			if (!targets.length) break;
			for (const p of deliverablePaths) {
				if (!targets.some((t) => under(t, p))) {
					findings.push({
						rule: "discipline-deliverable-conflict",
						severity: "high",
						message: `纪律『只动 ${targets.join("、")}』与交付物『${p}』冲突——任务书自相矛盾逼分身当裁判，改书再派`,
						evidence: line,
					});
				}
			}
			break; // 每行纪律只取第一个匹配
		}
	}

	// 规则2：挂 npm test 链 → 硬停时长预估提醒
	const scopeText = [...sheet.deliverables, ...sheet.acceptance].join("\n");
	if (/npm\s+test|npm\s+run\s+test|测试链|全套测试|test\s+suite/i.test(scopeText)) {
		findings.push({
			rule: "npm-test-hard-stop-estimate",
			severity: "medium",
			message: "交付物挂 npm test 链——硬停时长（timeout）预估必须按全套测试套件时长算（T10 教训：25min 掐在最后一公里），别按干活时长拍脑袋",
		});
	}

	return findings;
}

/**
 * lint 退出码：0=干净 / 1=严格模式见高危 / 2=lint 自身用法错（出声不是静默放行）。
 */
export function lintExitCode(findings, { strict = false } = {}) {
	if (strict && findings.some((f) => f.severity === "high")) return 1;
	return 0;
}

/**
 * 端到端包装：文本 → 解析 → lint → { findings, exitCode }。
 * lint 跑不起来（输入非文本/空/解析拒绝）→ exitCode 2 + error finding，不静默放行。
 */
export function runLint(text, { strict = false } = {}) {
	if (typeof text !== "string" || !text.trim()) {
		return {
			findings: [{ rule: "lint-usage", severity: "error", message: "lint 用法错：输入为空或非文本" }],
			exitCode: 2,
		};
	}
	let sheet;
	try {
		sheet = parseCastingSheet(text);
	} catch (err) {
		return {
			findings: [{ rule: "lint-usage", severity: "error", message: `lint 跑不起来：任务书解析拒绝——${err.message}` }],
			exitCode: 2,
		};
	}
	const findings = lintSheet(sheet);
	return { findings, exitCode: lintExitCode(findings, { strict }) };
}
