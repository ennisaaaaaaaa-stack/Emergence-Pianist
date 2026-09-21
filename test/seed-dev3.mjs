// 造真热点（形状与真 pianist 事件一致）：pianist-dev-X 四个独立会话跑同构环境检查
// 真实工作流形状：每场会话开头做同一套三连检查，无判断纯搬运——第二闭环的正牌猎物
//
// 默认写 /tmp（造数脚本永不直写真账目录——手滑防线，review 问3结构性建议）。
// 要进真账目录：显式 --out data/telemetry/xxx.jsonl 且文件名必须带 test- 前缀
// （test- 前缀 = 扫描器不进统计的约定，见 src/hotspot-scanner.mjs）
import fs from "node:fs";
const args = process.argv.slice(2);
const outIdx = args.indexOf("--out");
const OUT = outIdx !== -1 ? args[outIdx + 1] : "/tmp/test-pianist-seed.jsonl";
if (!OUT.includes("/test-")) {
	console.error(`[seed] 拒绝：输出路径必须含 test- 前缀（${OUT}）——测试烟不进真账`);
	process.exit(1);
}
const day = "2026-09-21";
const iso = (m) => new Date(Date.now() - m * 60_000).toISOString();
let lines = [];
for (let s = 0; s < 4; s++) {
	lines.push(JSON.stringify({ v: 1, ts: iso(60 - s * 10), agent: "pianist-dev-3", kind: "session_mark", data: { note: "env check" } }));
	for (const cmd of ["nproc", "free -m | head -2", "df -h /tmp"]) {
		lines.push(JSON.stringify({ v: 1, ts: iso(60 - s * 10), agent: "pianist-dev-3", kind: "tool_use", data: { tool: "bash", input: { command: cmd }, isError: false, durationMs: 50, resultBytes: 100 } }));
	}
}
fs.mkdirSync(OUT.slice(0, OUT.lastIndexOf("/")), { recursive: true });
fs.appendFileSync(OUT, lines.join("\n") + "\n");
console.log("seeded", lines.length, "lines →", OUT);
