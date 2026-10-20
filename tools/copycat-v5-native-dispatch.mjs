// copycat-v5-native-dispatch.mjs — 原生尺寸四图迭代轮（10/17 晚，the user睡前拍板）
// 与 v4 的区别：a.输出原生尺寸（各图原生分辨率）b.任务书只给「上轮工件延续指针」（迭代语义），
// 方法论零指针（画法书/spoor 不提）——环境说明书 APPEND_SYSTEM.md 已自动在场，翻不翻=纯自发测点
// c.JPEG 振铃事实给全不给解法（the user 15:05 拍板）d.单次运行限放宽 15s e.预算 60min/单
import { buildRuntime } from "/root/portalk-runtime/src/orchestrator/runtime.mjs";
import fs from "node:fs";
import { spawn } from "node:child_process";

const TASKS = [
	{ id: "copycat-v5-1", ref: "1fa0dc301e9c242f65331d0259e8ec1c", w: 564, h: 560, prev: "copycat-v4-1", tribe: "A 颗粒宇宙（暗夜新月+光柱+小人+地平线）——上轮 blockMAE 0.46 全 lab 纪录" },
	{ id: "copycat-v5-2", ref: "7e5ef6855cf5c1653df68ab853187547", w: 900, h: 1260, prev: "copycat-v4-2", tribe: "B 门柱拱门（纵构图）——上轮 blockMAE 1.59" },
	{ id: "copycat-v5-3", ref: "6f31ec5cc28047737574081d3d1be87c", w: 1080, h: 1080, prev: "copycat-v4-3", tribe: "C 渐变流（方图）——上轮成绩见其 iteration-log" },
	{ id: "copycat-v5-4", ref: "0cbc17d5da1723f7ee532ed7fcaeaabe", w: 736, h: 736, prev: "copycat-v4-4", tribe: "上轮首画的新参考图——成绩见其 iteration-log" },
];

function sheetFor(t) {
	const hasPrev = fs.existsSync(`/root/brush-lab/tests/${t.prev}/paint.py`);
	const prevSeg = hasPrev
		? `上轮你的工件（延续迭代的起点，改画布参数重对表，不是从零重画）：/root/brush-lab/tests/${t.prev}/。注意：上轮施工可能被机器关机中断（不是任何人的失误）——工件是中途状态，iteration-log 可能缺失或滞后，以盘上代码与你自己的重新观察为准。`
		: `这是此图首画（无上轮工件）——画前先做观察读数建立结构模型；如参考图未入族基线，先自验族属。`;
	return `
任务：${t.id} 原生尺寸1:1复刻·在上轮基础上迭代（不用尺规）

角色表：
  - 角色:worker pianist | 数量:1 | 沙箱:无 | 审链:评审员
  - 角色:评审员 | 数量:1 | 沙箱:无 | 模型:zai-coding-cn/glm-5.3-flash

预算袋：时长 60 分钟

背景与边界：
工作区 /root/brush-lab/tests/${t.id}/（新建，全部产物进这里）。参考图 /root/brush-lab/references/refs/${t.ref}.jpg（${t.tribe}）。
本轮变化：输出不再是 200x200，而是原生尺寸 ${t.w}x${t.h}——像素面积是上轮的 ${Math.round(t.w * t.h / 40000)} 倍，所有读数重新对表。
${prevSeg}
自由语言单：禁用 src/canvas.py 尺规引擎——纯 PIL/numpy。允许 import PIL、numpy；禁止读参考图逐像素抄进画布（观察可以，逐像素复制不行——你写的是绘画程序不是解码器）。
禁网的墙不变：可以查 W3C 规范类知识（你本来就知道的），不得 clone 外部代码。

格式事实（不是解法，你自己判断）：参考图是 JPEG 有损压缩——原生尺寸下高频里 JPEG 振铃/块痕比 200px 缩图显著更多。哪些高频值得复刻、哪些是压缩损伤，由你的判断定。

交付物清单：
- /root/brush-lab/tests/${t.id}/paint.py（绘画程序：可重跑，出图逐字节同）
- /root/brush-lab/tests/${t.id}/out.png（${t.w}x${t.h} 原生尺寸）
- /root/brush-lab/tests/${t.id}/control.png（阴性对照：删主内容层只留底）
- /root/brush-lab/tests/${t.id}/iteration-log.md（每轮：改了什么+预期+读数）
- /root/brush-lab/tests/${t.id}/self-review.md（自评：构图/色调/质感三档+与参考图肉眼差距一句话）
- 桌面交付（画完的图给人看）：out.png 复制到 <user-home>/Desktop/pianist工具迭代/交付成果（命名时注明时间顺序）/，文件名 ${t.id}-YYYY-MM-DD-HHMM.png（复制时刻）

验收标准：
- out.png ${t.w}x${t.h} 面积非空；paint.py 重跑 sha256 逐字节同
- 阴性对照与参考图差异远大于成品与参考图差异
- iteration-log 至少 3 轮迭代记录（有读数——原生尺寸下的新读数）
- paint.py 单次运行 ≤15 秒（原生尺寸余量）
- 桌面交付文件在位

纪律：
- brush-lab 非 git 仓：不 commit 不推
- 参考了外部实现或前人沉淀，记 ${t.id}/references-external.md（无则写「无」）
- 评审员会是另一个分身（glm-5.3-flash），它会看你的交付物并给 VERDICT:pass/fail——你的自评要诚实，红项藏不住
- /tmp 调试残留别清
- 卡死 BLOCKED:环境: <原因>；完成 DONE <一句话清单>
`;
}

// —— 串行四单，可续跑：node copycat-v5-native-dispatch.mjs copycat-v5-3 ——
const startFrom = process.argv[2] ?? null;
const startIdx = startFrom ? TASKS.findIndex((t) => t.id === startFrom) : 0;
if (startFrom && startIdx < 0) throw new Error(`未知任务 id：${startFrom}`);

const summary = [];
for (const t of TASKS.slice(Math.max(0, startIdx))) {
	console.log(`\n========== ${t.id}（${t.w}x${t.h} 原生·${t.tribe}）==========`);
	const rt = buildRuntime({
		sheetText: sheetFor(t),
		cwd: "/root/portalk-runtime",
		shellUrl: "http://127.0.0.1:8770",
	});

	// 源3 消费方接线（与 v4 同款）：施工分身交付 → 自动拉场景二收尾分身
	let corpseDone = false;
	rt.sessionEndHook.register((ev) => {
		if (ev.outcome === "done" && !corpseDone) {
			corpseDone = true;
			const files = rt.watcher.locked(ev.minionId);
			const sessionFile = files && files.length > 0 ? files[files.length - 1] : null;
			console.log(`[源3] ${ev.minionId} outcome=${ev.outcome} → 尸体 ${sessionFile ? sessionFile.split("/").pop() : "(未锁到)"}`);
			if (sessionFile) {
				const child = spawn("node", ["src/retropad.mjs", "--hook", "--session", sessionFile], {
					cwd: "/root/portalk-runtime",
					stdio: ["ignore", "pipe", "pipe"],
					env: { ...process.env },
				});
				let out = "";
				child.stdout.on("data", (d) => { out += d; });
				child.stderr.on("data", (d) => { out += d; });
				child.on("exit", (code) => {
					console.log(`[源3] 收尾分身 exit=${code}\n${out.split("\n").slice(-6).join("\n")}`);
				});
			}
		}
	});

	rt.startLoop(2000);
	const rec = rt.launchMinion({ taskId: t.id, role: "worker pianist" });
	console.log(`spawn: ${rec.minionId} pid=${rec.pid}`);

	const t0 = Date.now();
	const TIMEOUT = 70 * 60 * 1000; // 70min 总窗（预算 60min+余量）
	await new Promise((resolve) => {
		const iv = setInterval(() => {
			const msgs = rt.inbox.peekAll();
			const deliveries = msgs.filter((m) => m.kind === "交货单");
			const bad = msgs.filter((m) => m.kind === "讣告" || (m.kind === "通知" && String(m.text ?? "").includes("发车失败")));
			const done = deliveries.length >= 2 || bad.length > 0;
			if (done || Date.now() - t0 > TIMEOUT) {
				clearInterval(iv);
				resolve();
			}
		}, 5000);
	});

	await new Promise((r) => setTimeout(r, 90 * 1000));
	rt.stop();

	const msgs = rt.inbox.peekAll();
	const deliveries = msgs.filter((m) => m.kind === "交货单");
	const bad = msgs.filter((m) => m.kind === "讣告" || (m.kind === "通知" && String(m.text ?? "").includes("发车失败")));
	const verdict = deliveries.find((m) => String(m.minionId ?? "").includes("-审-"))?.manifest?.verdict ?? null;
	const mins = Math.round((Date.now() - t0) / 60000);
	summary.push({ id: t.id, mins, deliveries: deliveries.length, verdict, bad: bad.length });
	console.log(`${t.id} 收口: ${mins}min 交货${deliveries.length} verdict=${verdict} 异常${bad.length}`);
	for (const d of deliveries) {
		console.log(`  交货: ${d.minionId} verdict=${d.manifest?.verdict ?? "-"}`);
	}
	fs.writeFileSync(`/tmp/${t.id}-inbox.json`, JSON.stringify(msgs, null, 1));
}

console.log("\n========== 四单总账 ==========");
for (const s of summary) console.log(JSON.stringify(s));
fs.writeFileSync("/tmp/copycat-v5-summary.json", JSON.stringify(summary, null, 1));
fs.mkdirSync("/root/portalk-runtime/data/copycat-v5", { recursive: true });
fs.writeFileSync("/root/portalk-runtime/data/copycat-v5/summary.json", JSON.stringify(summary, null, 1));
console.log("wrote /tmp/copycat-v5-summary.json + data/copycat-v5/summary.json");
process.exit(0);
