// 施工③第二步：聚合热点扫描器（纯机械、零 LLM、无状态——每次全量重扫）
//
// 架构依据：Pianist-自学习双闭环.md §3 闸门二（三维分工）+ §9（错误统计机械化）
//   重复性 = 系统的活：序列指纹出现次数（滑窗 + 同 burst 去重叠）
//   确定性 = 系统的活：同指纹下执行形状收敛度（top 形状占比）
//   认知浪费 = 分身的活：本工具永不判断这一维
// 产出 = 闸门一的预处理输入（指针+结论，不给全文）。
//
// 可拆卸性：独立可执行文件，读 data/telemetry/ JSONL，不依赖壳进程在场。
// 出声纪律（§9 遥测丢失必须出声）：读了什么、坏了多少、拒了多少，全部进输出。
//
// 用法：
//   node src/hotspot-scanner.mjs [--dir data/telemetry] [--out data/hotspots/latest.json]
//        [--window 3] [--min-occ 3] [--min-conv 0.8] [--min-err 3] [--days 14]
//   --out - 表示只打 stdout 不落盘
// 退出码：0=正常扫完（零热点也是合法结果）；1=输入不可读（目录不存在/全坏）。

import fs from "node:fs";
import path from "node:path";

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

const DIR = arg("dir", "data/telemetry");
const OUT = arg("out", "data/hotspots/latest.json");
const W = Math.max(2, parseInt(arg("window", "3"), 10) || 3);
const MIN_OCC = Math.max(2, parseInt(arg("min-occ", "3"), 10) || 3);
const MIN_CONV = Math.min(1, Math.max(0, parseFloat(arg("min-conv", "0.8")) || 0.8));
const MIN_ERR = Math.max(2, parseInt(arg("min-err", "3"), 10) || 3);
const DAYS = Math.max(1, parseInt(arg("days", "14"), 10) || 14);

// ---------------------------------------------------------------------------
// 输入形状归一化（确定性的地基）
// ---------------------------------------------------------------------------

/** token 级归一化：引号串→⟨S⟩、十六进制哈希→⟨H⟩、数字→⟨N⟩、空白折叠 */
function normTokens(s) {
	return s
		.replace(/'[^']*'|"[^"]*"/g, "⟨S⟩")
		.replace(/\b[0-9a-f]{8,40}\b/gi, "⟨H⟩")
		.replace(/\d+(\.\d+)?/g, "⟨N⟩")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120);
}

/**
 * 执行形状：工具调用的「结构骨架」。
 * bash 类走 command 归一化；其余按排序键的浅层形状（字符串值归一化、数字/布尔→§、嵌套→…）。
 * 语义：形状相同 ≈ 同一类操作；形状不同 = 不同任务，不该贡献确定性。
 */
function execShape(tool, input) {
	if (input == null || typeof input !== "object") return `${tool}::∅`;
	if (typeof input.command === "string") return `${tool}::cmd:${normTokens(input.command)}`;
	try {
		const keys = Object.keys(input).sort();
		const body = keys
			.map((k) => {
				const v = input[k];
				if (typeof v === "string") return `${k}=${normTokens(v).slice(0, 64)}`;
				if (typeof v === "number" || typeof v === "boolean") return `${k}=§`;
				return `${k}=…`;
			})
			.join("&");
		return `${tool}::${body}`.slice(0, 200);
	} catch {
		return `${tool}::?`;
	}
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

function scan() {
	if (!fs.existsSync(DIR) || !fs.statSync(DIR).isDirectory()) {
		console.error(`[hotspot-scanner] 遥测目录不可读: ${DIR} —— 扫描器拒绝静默返回空结果（暗区检测器不许制造暗区）`);
		process.exit(1);
	}

	// 按日期文件名排序（{agent}-{YYYY-MM-DD}.jsonl），只取最近 N 天
	const cutoff = new Date(Date.now() - DAYS * 86400_000).toISOString().slice(0, 10);
	const allFiles = fs.readdirSync(DIR).filter((f) => f.endsWith(".jsonl")).sort();
	// test- 前缀 = 造数脚本产物（约定见 README），不进统计——测试烟不报真火（review 问3第二层）
	const testSkipped = allFiles.filter((f) => f.startsWith("test-"));
	const files = allFiles
		.filter((f) => !f.startsWith("test-"))
		.filter((f) => {
			const m = f.match(/-(\d{4}-\d{2}-\d{2})\.jsonl$/);
			return m ? m[1] >= cutoff : true; // 命名不规范的文件不按日期排除（宁可多读）
		});

	// 出声台账
	const sources = [];
	let totalEvents = 0;
	const kindCount = {};
	const usageByAgent = {}; // agent -> {calls, totalTokens, cost}

	// agent -> 有序 tool_use 流（跨文件按文件序拼接；session_mark 与文件边界都切段）
	const streams = {};
	// 错误热点：agent -> `${tool}::shape` -> {count, firstTs, lastTs, evidence[]}
	const errorGroups = {};

	for (const f of files) {
		const full = path.join(DIR, f);
		const agent = f.replace(/-\d{4}-\d{2}-\d{2}\.jsonl$/, "").replace(/\.jsonl$/, "");
		let lines;
		try {
			lines = fs.readFileSync(full, "utf8").split("\n");
		} catch (e) {
			sources.push({ file: f, lines: 0, parseErrors: 1, error: String(e.message || e) });
			continue;
		}
		let parseErrors = 0;
		let counted = 0;
		const stream = (streams[agent] ??= []);
		for (let i = 0; i < lines.length; i++) {
			const raw = lines[i].trim();
			if (!raw) continue;
			let ev;
			try {
				ev = JSON.parse(raw);
			} catch {
				parseErrors++;
				continue;
			}
			if (!ev || typeof ev !== "object" || typeof ev.kind !== "string") {
				parseErrors++;
				continue;
			}
			counted++;
			totalEvents++;
			kindCount[ev.kind] = (kindCount[ev.kind] || 0) + 1;

			if (ev.kind === "tool_use" && typeof ev.data?.tool === "string") {
				stream.push({
					tool: ev.data.tool,
					shape: execShape(ev.data.tool, ev.data.input),
					isError: ev.data.isError === true,
					ts: ev.ts,
					file: f,
					line: i + 1,
				});
				if (ev.data.isError === true) {
					const key = `${ev.data.tool}::${execShape(ev.data.tool, ev.data.input).split("::")[1]}`;
					const g = (errorGroups[agent] ??= {});
					(g[key] ??= { count: 0, first: null, last: null, evidence: [] });
					const grp = g[key];
					grp.count++;
					if (!grp.first) {
						grp.first = ev.ts;
						grp.evidence.push({ file: f, line: i + 1 });
					}
					grp.last = ev.ts;
					if (grp.evidence.length < 3 && grp.evidence[grp.evidence.length - 1].file !== f) {
						grp.evidence.push({ file: f, line: i + 1 });
					}
				}
			} else if (ev.kind === "session_mark") {
				stream.push({ boundary: true }); // 切段：窗口不跨会话边界
			} else if (ev.kind === "message_end") {
				const u = ev.data?.usage;
				if (u && typeof u === "object") {
					const a = (usageByAgent[agent] ??= { calls: 0, totalTokens: 0, cost: 0 });
					a.calls++;
					a.totalTokens += Number(u.totalTokens) || 0;
					a.cost += Number(u.cost?.total) || 0;
				}
			}
		}
		sources.push({ file: f, lines: counted, parseErrors });
	}

	const totalParseErrors = sources.reduce((s, x) => s + (x.parseErrors || 0), 0);
	if (totalEvents === 0) {
		console.error(`[hotspot-scanner] 窗口期内零事件（files=${files.length}）——若 pianist 在跑，这是遥测丢失，不是没有热点`);
	}

	// ---- 滑窗匹配 + 每 fp 内贪心选不重叠出现（burst 去重叠）----
	// fpGroups: agent -> fpName -> { positions: [streamIdx], }
	const hotspots = [];
	let rejectedByConv = 0;

	for (const [agent, stream] of Object.entries(streams)) {
		const fpPos = new Map(); // fpName -> [idx...]（滑动所有位置）
		for (let i = 0; i + W <= stream.length; i++) {
			const win = stream.slice(i, i + W);
			if (win.some((e) => e.boundary)) continue;
			const name = win.map((e) => e.tool).join("|");
			(fpPos.get(name) ?? fpPos.set(name, []).get(name)).push(i);
		}
		for (const [name, positions] of fpPos) {
			// 贪心选不重叠：与上一个已选位置距离 >= W
			const selected = [];
			for (const p of positions) {
				if (selected.length === 0 || p - selected[selected.length - 1] >= W) selected.push(p);
			}
			const occ = selected.length;
			if (occ < MIN_OCC) continue;

			// 确定性：selected 位置上的执行形状收敛度
			const shapeCount = new Map();
			for (const p of selected) {
				const shape = stream.slice(p, p + W).map((e) => e.shape).join(" | ");
				shapeCount.set(shape, (shapeCount.get(shape) || 0) + 1);
			}
			const sorted = [...shapeCount.entries()].sort((a, b) => b[1] - a[1]);
			const [topShape, topCount] = sorted[0];
			const conv = topCount / occ;
			if (conv < MIN_CONV) {
				rejectedByConv++;
				continue;
			}
			const first = stream[selected[0]];
			const last = stream[selected[selected.length - 1]];
			hotspots.push({
				agent,
				windowFp: name,
				occurrences: occ,
				convergence: Number(conv.toFixed(3)),
				topExecShape: topShape,
				shapeVariants: sorted.length,
				firstTs: first.ts,
				lastTs: last.ts,
				evidence: { file: first.file, line: first.line, lastFile: last.file, lastLine: last.line },
			});
		}
	}

	hotspots.sort((a, b) => b.occurrences - a.occurrences || b.convergence - a.convergence);

	const errorHotspots = [];
	for (const [agent, groups] of Object.entries(errorGroups)) {
		for (const [key, g] of Object.entries(groups)) {
			if (g.count >= MIN_ERR) {
				errorHotspots.push({ agent, shape: key, count: g.count, firstTs: g.first, lastTs: g.last, evidence: g.evidence });
			}
		}
	}
	errorHotspots.sort((a, b) => b.count - a.count);

	const report = {
		v: 1,
		generatedAt: new Date().toISOString(),
		params: { dir: DIR, window: W, minOcc: MIN_OCC, minConv: MIN_CONV, minErr: MIN_ERR, days: DAYS },
		voice: {
			// 出声区：扫描器自己的健康账
			filesConsidered: allFiles.length,
			filesScanned: files.length,
			testSkipped: testSkipped.length, // test- 前缀造数文件：留档在库但不进统计
			eventsParsed: totalEvents,
			parseErrors: totalParseErrors,
			rejectedByConvergence: rejectedByConv,
			knownBlindSpot: "壳侧 >32KB 拒收事件在本层不可见（写入时已丢）",
		},
		sources,
		totals: { kindCount, usageByAgent },
		hotspots,
		errorHotspots,
	};

	return report;
}

const report = scan();

// ---- 人类可读摘要（stdout）----
const v = report.voice;
console.log(`[hotspot-scanner] 扫描 ${report.params.dir}：${v.filesScanned}/${v.filesConsidered} 文件（${report.params.days} 天窗），${v.eventsParsed} 事件，坏行 ${v.parseErrors}${v.testSkipped ? `，test- 造数跳过 ${v.testSkipped}` : ""}`);
console.log(`[hotspot-scanner] 热点 ${report.hotspots.length} 个（因确定性不足拒 ${v.rejectedByConvergence} 个重复序列）；错误热点 ${report.errorHotspots.length} 个`);
for (const h of report.hotspots.slice(0, 10)) {
	console.log(`  ★ ${h.agent} ×${h.occurrences} conv=${h.convergence} [${h.windowFp}]`);
}
for (const e of report.errorHotspots.slice(0, 10)) {
	console.log(`  ✗ ${e.agent} ×${e.count} ${e.shape.slice(0, 100)}`);
}

// ---- 落盘 / stdout ----
const json = JSON.stringify(report, null, 2);
if (OUT === "-") {
	console.log(json);
} else {
	fs.mkdirSync(path.dirname(OUT), { recursive: true });
	fs.writeFileSync(OUT, json);
	console.log(`[hotspot-scanner] 报告落盘 ${OUT}`);
}
