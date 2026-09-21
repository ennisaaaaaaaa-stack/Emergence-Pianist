#!/usr/bin/env node
/**
 * retropad — 复盘分身拉起器（施工③第三步，2026-09-21）
 *
 * 自学习双闭环的「第三维判断」主体：拿扫描器的热点报告（预处理过的结论+指针），
 * 只判机器判不了的那一维——「这个热点还值不值得一个会推理的主体重新想一遍」。
 *
 * 三道闸门的落地姿势：
 *   闸门一（输入）  ：输入 = data/hotspots/latest.json + 指针（文件+行号），不给原始日志。
 *                     分身只有 pianist_bridge 一个工具（读面），读不到全文——省读取量不省信息量。
 *   闸门二（输出）  ：「本场没有值得记的」是合法输出且应是多数——分身 prompt 里明写。
 *                     有货 → candidate draft → Grimoire POST /skill（draft 起步，扫描坨只记不拦）。
 *                     产房不是户口：draft 不是 skill，转正走巡山。
 *   闸门三（存在）  ：本进程 = 按需拉起的分身本体。跑完即退，绝不常驻，没有待命池。
 *
 * 可拆卸性：独立进程，不在pianist会话进程树里。它挂了 = 自学习停摆，会话主干无感。
 * 触发：手动 / cron / 未来的 session 收尾钩子——三个触发源都只是 exec 本文件。
 *
 * 用法：
 *   node src/retropad.mjs [--report data/hotspots/latest.json] [--agent pianist-dev-1]
 *                         [--timeout 240] [--dry-run]
 *   --dry-run：不投Grimoire，只打印分身的裁决 JSON（调试用）。
 * 退出码：0=分身正常收工（含「没有值得记的」）；2=报告不可读/形状坏；3=分身超时/失败。
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
function arg(name, dflt) {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return dflt;
	const v = args[i + 1];
	return v === undefined || v.startsWith("--") ? dflt : v;
}

const REPORT = arg("report", "data/hotspots/latest.json");
const AGENT = arg("agent", "pianist-dev-1");
const TIMEOUT = Math.max(60, parseInt(arg("timeout", "240"), 10) || 240);
const DRY = args.includes("--dry-run");
const CWD = path.resolve(import.meta.dirname, "..");
const SHELL_URL = process.env.PIANIST_SHELL_URL ?? "http://127.0.0.1:8770";

// ---------------------------------------------------------------------------
// 读报告（闸门一：预处理输入）
// ---------------------------------------------------------------------------

if (!fs.existsSync(REPORT)) {
	console.error(`[retropad] 报告不可读: ${REPORT} —— 先跑 hotspot-scanner`);
	process.exit(2);
}
const report = JSON.parse(fs.readFileSync(REPORT, "utf8"));
if (!report || report.v !== 1 || !Array.isArray(report.hotspots) || !Array.isArray(report.errorHotspots)) {
	console.error(`[retropad] 报告形状坏（要 v1 hotspots/errorHotspots）`);
	process.exit(2);
}

// 热点数超过单次分身可消化量 → 只取头部，剩下的留给下次（扫描器已按 occ 排序）
const MAX_PER_RUN = 10;
const hotspots = report.hotspots.slice(0, MAX_PER_RUN);
const errorHotspots = report.errorHotspots.slice(0, MAX_PER_RUN);

if (hotspots.length === 0 && errorHotspots.length === 0) {
	// 零热点 = 没有事件就没有分身（闸门三）：不拉 pi，直接收工
	console.log(`[retropad] 报告零热点（${REPORT}）——没有事件就没有进程，分身不拉起`);
	process.exit(0);
}

// ---------------------------------------------------------------------------
// 组装分身输入（指针+结论，不给全文）
// ---------------------------------------------------------------------------

const hotBrief = hotspots.map((h, i) => {
	const ev = `${h.evidence.file}#${h.evidence.line}..${h.evidence.lastLine}`;
	return `${i + 1}. [重复] agent=${h.agent} ×${h.occurrences} 收敛度=${h.convergence} 序列=[${h.windowFp}] 执行形状=${h.topExecShape} 首末=${h.firstTs}~${h.lastTs} 证据指针=${ev}`;
});
const errBrief = errorHotspots.map((e, i) => {
	const evs = e.evidence.map((x) => `${x.file}#${x.line}`).join(", ");
	return `${i + 1}. [错误] agent=${e.agent} ×${e.count} 形状=${e.shape} 首末=${e.firstTs}~${e.lastTs} 证据指针=${evs}`;
});

const prompt = `你是 Pianist 的复盘分身（retropad）。你的唯一任务：对下面这些机械扫描攒出的热点，判断第三维——认知浪费：这步骤还值不值得一个会推理的主体重新想一遍。

## 你拿到的是预处理过的热点摘要（重复性和确定性已由扫描器机械判过，不用你判）

重复热点（指纹×次数×收敛度）：
${hotBrief.join("\n") || "（无）"}

错误热点（同形状失败聚合）：
${errBrief.join("\n") || "（无）"}

## 判断纪律

1. 「本场没有值得记的」是合法输出，且应是多数情况。不要为了交差硬造 candidate。
2. 机械两维已经过阈——你要判的是它们判不了的：这个重复是「值得保留的判断被机械重复」还是「本可编译掉的搬运」？错误热点值得记的判据是「同类失败反复出现且没有既有 capability 接住」。
3. 每个 candidate 必须能回答：编译掉的是什么判断、为何不心疼（JP 降权签名）、何时交回判断（适用条件/必须上浮的情形）。
4. 你只有一个工具 pianist_bridge（action=payload 形如 {action:"grimoire_map", payload:{}}），只能读Grimoire的经图查重——已有 capability 直接复用，不重复提交。
5. 产出格式：最后一个 message 必须是合法 JSON（其余解释文字放前面）：
   {"verdict":"nothing"|"candidates", "candidates":[{"name":"...","tags":["..."],"body":"...","trigger":"...","boundary":"...","why":"..."}], "note":"一句话收工说明"}

现在开始。先查经图，再下裁决。`;

// ---------------------------------------------------------------------------
// 拉起分身（闸门三：跑完即退）
// ---------------------------------------------------------------------------

const env = {
	...process.env,
	PIANIST_AGENT_ID: "retropad-1",
	PIANIST_SHELL_URL: SHELL_URL,
	NO_COLOR: "1",
	// key 传递：只走 env，仓库不带默认值
	ZAI_CODING_CN_API_KEY: process.env.ZAI_CODING_CN_API_KEY,
};
// 分身不采集遥测（否则扫描器会看见复盘分身自己的循环）
env.PIANIST_TELEMETRY = "off";

console.log(`[retropad] 拉起复盘分身：${hotspots.length} 重复热点 + ${errorHotspots.length} 错误热点，timeout=${TIMEOUT}s${DRY ? "，dry-run" : ""}`);

const child = spawn("./node_modules/.bin/pi", ["-p", "--model", "zai-coding-cn/glm-5.2", prompt], {
	cwd: CWD,
	env,
	stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
const timer = setTimeout(() => {
	console.error(`[retropad] 分身超时（${TIMEOUT}s）——杀`);
	child.kill("SIGKILL");
}, TIMEOUT * 1000);

child.stdout.on("data", (d) => { stdout += d.toString(); });
child.stderr.on("data", (d) => { stderr += d.toString(); });

child.on("close", (code) => {
	clearTimeout(timer);
	if (code !== 0 && !stdout) {
		console.error(`[retropad] 分身失败 exit=${code}\n${stderr.slice(0, 500)}`);
		process.exit(3);
	}
	// 从 stdout 提取最后一个 JSON 对象：从最后的 { 逐个回退试后缀解析
	// （贪婪正则会把「解释文字里的 JSON + 裁决 JSON」并成一个块，解析必炸）
	const cleaned = stdout.replace(/```(?:json)?/g, "").trimEnd();
	let verdict = null;
	for (let i = cleaned.lastIndexOf("{"); i >= 0; i = cleaned.lastIndexOf("{", i - 1)) {
		try { verdict = JSON.parse(cleaned.slice(i)); break; } catch { /* 回退下一个 { */ }
	}
	if (!verdict || typeof verdict.verdict !== "string") {
		console.error(`[retropad] 分身输出无合法 JSON 裁决——原始输出尾 800 字：\n${stdout.slice(-800)}`);
		process.exit(3);
	}

	console.log(`[retropad] 分身裁决: ${verdict.verdict}${verdict.note ? ` —— ${verdict.note}` : ""}`);

	if (verdict.verdict === "nothing") {
		console.log(`[retropad] 本场没有值得记的——合法输出，收工`);
		process.exit(0);
	}

	const cands = Array.isArray(verdict.candidates) ? verdict.candidates : [];
	if (cands.length === 0) {
		console.error(`[retropad] verdict=candidates 但列表空——形状坏，当 nothing 收但不投`);
		process.exit(3);
	}

	// 投Grimoire（闸门二出口：draft 起步，扫描坨只记不拦）
	const submit = async (c) => {
		const res = await fetch(`${SHELL_URL}/tools/invoke`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				action: "grimoire_submit",
				payload: {
					name: c.name,
					tags: c.tags ?? ["self-learning"],
					body: c.body ?? "",
					trigger: c.trigger ?? "",
					boundary: c.boundary ?? "",
					why: c.why ?? "",
					author: "retropad-1",
					source: "self",
				},
				agent: "retropad-1",
			}),
		});
		return { status: res.status, body: await res.text() };
	};

	(async () => {
		if (DRY) {
			console.log(`[retropad] dry-run：${cands.length} 个 candidate 不投，内容如下`);
			for (const c of cands) console.log(JSON.stringify(c, null, 2));
			process.exit(0);
		}
		for (const c of cands) {
			try {
				const r = await submit(c);
				const ok = r.status === 200;
				console.log(`  ${ok ? "✓" : "✗"} ${c.name} → Grimoire HTTP ${r.status}${ok ? "" : `: ${r.body.slice(0, 200)}`}`);
				if (!ok && r.status !== 409) process.exitCode = 3; // 409=同名已提交过，幂等处理不算失败
			} catch (e) {
				console.error(`  ✗ ${c.name} → 提交异常: ${e.message}`);
				process.exitCode = 3;
			}
		}
		console.log(`[retropad] 收工：${cands.length} 个 candidate 已投Grimoire（draft）——产房不是户口，转正走巡山`);
	})();
});
