// copycat-free-x3-dispatch.mjs — 三任务实验·编排器真身发车（10/16）
// the user实验：三图各一单，自由语言（不用尺规），评审员=5.3-flash（审链自动编排首跑）。
// 每单：casting sheet → launchMinion（worker pianist）→ 施工 DONE → completionPump 自动派评审员 → VERDICT 落收件箱。
// 主 agent 不导演——这是编排层自组织的首测。串行跑（任务一收口再发任务二）。
import { buildRuntime } from "../src/orchestrator/runtime.mjs";
import fs from "node:fs";

const TASKS = [
	{
		id: "copyfree-1",
		ref: "1fa0dc301e9c242f65331d0259e8ec1c",
		tribe: "A 颗粒宇宙（暗夜新月+光柱+小人+地平线）",
		pointer: null, // 任务一：从零——不给 v3 迭代日志（保实验纯度，the user拍板）
	},
	{
		id: "copyfree-2",
		ref: "6f31ec5cc28047737574081d3d1be87c",
		tribe: "C 渐变流",
		pointer: "/root/brush-lab/references/tribe-freq-baseline.json", // 任务二三：给族参照（公平起点）
	},
	{
		id: "copyfree-3",
		ref: "7e5ef6855cf5c1653df68ab853187547",
		tribe: "B 门柱",
		pointer: "/root/brush-lab/references/tribe-freq-baseline.json",
	},
];

const POINTER_LINE = (t) => t.pointer ? `指针:${t.pointer}` : "";

function sheetFor(t) {
	const pointerSeg = t.pointer ? ` | 指针:${t.pointer}` : "";
	return `
任务：${t.id} 自由语言1:1复刻（不用尺规）

角色表：
  - 角色:worker pianist | 数量:1 | 沙箱:无 | 审链:评审员${pointerSeg}
  - 角色:评审员 | 数量:1 | 沙箱:无 | 模型:zai-coding-cn/glm-5.3-flash

预算袋：时长 40 分钟

背景与边界：
工作区 /root/brush-lab/tests/${t.id}/（新建，全部产物进这里）。参考图 /root/brush-lab/references/refs/${t.ref}.jpg（${t.tribe}）。
自由语言单：禁用 src/canvas.py 尺规引擎——用纯 PIL/numpy 从零写绘画程序。允许 import PIL、numpy；禁止读参考图逐像素抄进画布（观察可以，逐像素复制不行——你写的是绘画程序不是解码器）。
禁网的墙不变：可以查 W3C 规范类知识（你本来就知道的），不得 clone 外部代码。

交付物清单：
- /root/brush-lab/tests/${t.id}/paint.py（绘画程序：可重跑，出图逐字节同）
- /root/brush-lab/tests/${t.id}/out.png（200x200）
- /root/brush-lab/tests/${t.id}/iteration-log.md（每轮：改了什么+预期+读数）
- /root/brush-lab/tests/${t.id}/control.png（阴性对照：删主内容层只留底）
- /root/brush-lab/tests/${t.id}/self-review.md（自评：构图/色调/质感三档+与参考图肉眼差距一句话）

验收标准：
- out.png 200x200 非空；paint.py 重跑 sha256 逐字节同
- 阴性对照与参考图差异远大于成品与参考图差异
- iteration-log 至少 3 轮迭代记录（有读数：block>=4 分块均色对比可自建，或任何你自造的读数）
- 图元/对象/调用预算：paint.py 单次运行 ≤5 秒（渲染不能靠暴力堆）

纪律：
- brush-lab 非 git 仓：不 commit 不推
- 参考了外部实现必须记 ${t.id}/references-external.md（无则写「无」）
- 评审员会是另一个分身（glm-5.3-flash），它会看你的交付物并给 VERDICT:pass/fail——你的自评要诚实，红项藏不住
- /tmp 调试残留别清
- 卡死 BLOCKED:环境: <原因>；完成 DONE <一句话清单>
`;
}

// —— 串行跑三单（可从指定任务续跑：node copyfree-x3-dispatch.mjs copyfree-2）——
const startFrom = process.argv[2] ?? null;
const startIdx = startFrom ? TASKS.findIndex((t) => t.id === startFrom) : 0;
if (startFrom && startIdx < 0) throw new Error(`未知任务 id：${startFrom}`);
const summary = [];
for (const t of TASKS.slice(Math.max(0, startIdx))) {
	console.log(`\n========== ${t.id}（${t.tribe}）==========`);
	const rt = buildRuntime({
		sheetText: sheetFor(t),
		cwd: "/root/portalk-runtime",
		shellUrl: "http://127.0.0.1:8770",
	});
	rt.startLoop(2000);
	const rec = rt.launchMinion({ taskId: t.id, role: "worker pianist" });
	console.log(`spawn: ${rec.minionId} pid=${rec.pid}`);

	// 等收口：交货单×2（施工+评审）或讣告/阻塞
	const t0 = Date.now();
	const TIMEOUT = 50 * 60 * 1000; // 50min 总窗（预算 40min+余量）
	await new Promise((resolve) => {
		const iv = setInterval(() => {
			const msgs = rt.inbox.peekAll();
			const deliveries = msgs.filter((m) => m.kind === "交货单");
			const bad = msgs.filter((m) => m.kind === "讣告" || m.kind === "通知");
			const done = deliveries.length >= 2 || bad.length > 0;
			if (done || Date.now() - t0 > TIMEOUT) {
				clearInterval(iv);
				resolve();
			}
		}, 5000);
	});
	rt.stop();

	// 收口摘要
	const msgs = rt.inbox.peekAll();
	const deliveries = msgs.filter((m) => m.kind === "交货单");
	const bad = msgs.filter((m) => m.kind === "讣告" || m.kind === "通知");
	const verdict = deliveries.find((m) => m.minionId?.includes("-审-"))?.manifest?.verdict ?? null;
	const mins = Math.round((Date.now() - t0) / 60000);
	summary.push({ id: t.id, mins, deliveries: deliveries.length, verdict, bad: bad.length, status: ledgerAll(rt) });
	console.log(`${t.id} 收口: ${mins}min 交货${deliveries.length} verdict=${verdict} 异常${bad.length}`);
	for (const d of deliveries) {
		console.log(`  交货: ${d.minionId} verdict=${d.manifest?.verdict ?? "-"}`);
	}
	fs.writeFileSync(`/tmp/${t.id}-inbox.json`, JSON.stringify(msgs, null, 1));
}

function ledgerAll(rt) {
	const rows = [...rt.ledger.rows.values()].map((r) => `${r.id}:${r.status}`);
	return rows.join(" ");
}

console.log("\n========== 三单总账 ==========");
for (const s of summary) console.log(JSON.stringify(s));
fs.writeFileSync("/tmp/copyfree-x3-summary.json", JSON.stringify(summary, null, 1));
console.log("wrote /tmp/copyfree-x3-summary.json");
process.exit(0);
