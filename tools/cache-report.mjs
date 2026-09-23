#!/usr/bin/env node
/**
 * cache-report —— §六 cached_tokens 观测（Tideline拓展蓝图 2026-09-24）
 *
 * 每次请求的 usage 已由壳层遥测落账（message_end.data.usage），
 * 这个脚本把 JSONL 聚合成可读指标：命中率从感觉变成数字。
 *
 *   node tools/cache-report.mjs            # 全部遥测，按 agent×日 聚合
 *   node tools/cache-report.mjs --tail 20  # 附最近 20 笔明细
 *   node tools/cache-report.mjs --agent pianist-dev-1 --day 2026-09-22
 *
 * 指标定义（与蓝图 §六对齐：稳定前缀+动态尾巴，前缀命中即 cacheRead）：
 *   hit_rate   = cacheRead / (input + cacheRead)          —— 注入面命中
 *   write_pct  = cacheWrite / (input + cacheRead + cacheWrite) —— 前缀重写占比（尾巴动了前缀的信号）
 *   半价口径   = cost.cacheRead 已按缓存价计，直接用
 */
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? args[i + 1] : undefined;
};
const TELEMETRY_DIR = process.env.PIANIST_TELEMETRY_DIR ?? path.resolve("data/telemetry");
const fAgent = flag("agent");
const fDay = flag("day");
const tailN = Number(flag("tail") ?? 0);

const files = fs.readdirSync(TELEMETRY_DIR).filter((f) => f.endsWith(".jsonl")).sort();
const rows = [];
for (const f of files) {
	const [agent, day] = f.replace(/\.jsonl$/, "").split(/-(?=\d{4}-)/);
	if (fAgent && agent !== fAgent) continue;
	if (fDay && day !== fDay) continue;
	for (const line of fs.readFileSync(path.join(TELEMETRY_DIR, f), "utf8").split("\n")) {
		if (!line.trim()) continue;
		let ev;
		try { ev = JSON.parse(line); } catch { continue; }
		if (ev.kind !== "message_end" || !ev.data?.usage) continue;
		const u = ev.data.usage;
		rows.push({
			agent, day, ts: ev.ts,
			input: u.input ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0,
			output: u.output ?? 0, cost: u.cost?.total ?? 0,
		});
	}
}

if (!rows.length) { console.log("无 message_end usage 记录"); process.exit(0); }

// 聚合 agent×day
const groups = new Map();
for (const r of rows) {
	const k = `${r.agent} ${r.day}`;
	const g = groups.get(k) ?? { agent: r.agent, day: r.day, n: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 };
	g.n++; g.input += r.input; g.cacheRead += r.cacheRead; g.cacheWrite += r.cacheWrite;
	g.output += r.output; g.cost += r.cost;
	groups.set(k, g);
}

const pct = (x) => (x * 100).toFixed(1) + "%";
console.log("agent            day         n   input   cacheRead  cacheWrite  output  hit_rate  write_pct  cost$");
console.log("-".repeat(104));
for (const g of [...groups.values()].sort((a, b) => (a.agent + a.day < b.agent + b.day ? -1 : 1))) {
	const hit = g.cacheRead + g.input ? g.cacheRead / (g.cacheRead + g.input) : 0;
	const wr = g.cacheRead + g.input + g.cacheWrite ? g.cacheWrite / (g.cacheRead + g.input + g.cacheWrite) : 0;
	console.log(
		String(g.agent).padEnd(16) + g.day.padEnd(11) + String(g.n).padEnd(4) +
		String(g.input).padEnd(8) + String(g.cacheRead).padEnd(11) + String(g.cacheWrite).padEnd(12) +
		String(g.output).padEnd(8) + pct(hit).padEnd(10) + pct(wr).padEnd(11) +
		g.cost.toFixed(4)
	);
}
const tot = [...groups.values()].reduce((a, g) => ({
	n: a.n + g.n, input: a.input + g.input, cacheRead: a.cacheRead + g.cacheRead,
	cacheWrite: a.cacheWrite + g.cacheWrite, output: a.output + g.output, cost: a.cost + g.cost,
}), { n: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 });
const totHit = tot.cacheRead + tot.input ? tot.cacheRead / (tot.cacheRead + tot.input) : 0;
console.log("-".repeat(104));
console.log(`TOTAL ${tot.n} 笔  hit_rate=${pct(totHit)}  cost=$${tot.cost.toFixed(4)}  （cached_tokens 按半价已计入 cost）`);

if (tailN > 0) {
	console.log(`\n最近 ${Math.min(tailN, rows.length)} 笔：`);
	for (const r of rows.slice(-tailN)) {
		const hit = r.cacheRead + r.input ? r.cacheRead / (r.cacheRead + r.input) : 0;
		console.log(`  ${r.ts} in=${r.input} rd=${r.cacheRead} wr=${r.cacheWrite} out=${r.output} hit=${pct(hit)}`);
	}
}
