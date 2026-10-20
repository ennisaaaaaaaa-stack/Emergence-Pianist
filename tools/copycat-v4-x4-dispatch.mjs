// copycat-v4-x4-dispatch.mjs — 测试③四图重跑·自学习链路整测（10/17）
// 测点：①pianist临摹质量（1:1 尺寸/精度/色彩/构图/质感）②自学习闭环——收尾分身自动沉淀 spoor + 下单冷启动复用
// 与上轮（copyfree-x3）的区别：
//   a. 每单交付后自动跑场景二收尾分身（源3 消费方接线——hook fire→retropad --hook --session）
//   b. 任务书「已知事实」给画法书/观察工具指针（上轮任务一纯冷启动）——测复用不测纯冷启动
//   c. 桌面交付规约恢复（上轮漏了）
import { buildRuntime } from "/root/portalk-runtime/src/orchestrator/runtime.mjs";
import fs from "node:fs";
import { spawn } from "node:child_process";

const TASKS = [
	{ id: "copycat-v4-1", ref: "1fa0dc301e9c242f65331d0259e8ec1c", tribe: "A 颗粒宇宙（暗夜新月+光柱+小人+地平线，族内最干净锚点）" },
	{ id: "copycat-v4-2", ref: "7e5ef6855cf5c1653df68ab853187547", tribe: "B 门柱拱门（900x1260 纵构图）" },
	{ id: "copycat-v4-3", ref: "6f31ec5cc28047737574081d3d1be87c", tribe: "C 渐变流（1080 方图）", stock: "工作区已有一次中断施工的残留产物（paint.py/out.png/control.png/probe1-5/score.py）——先读它们再决定复用或重写，iteration-log 与 self-review 从你的会话重新记起（中断是机器关机，不是任何人的失误）" },
	{ id: "copycat-v4-4", ref: "0cbc17d5da17223f7ee532ed7fcaeaabe", tribe: "未入族基线的新参考图（736 方图）——画前先自验族属（_freq_read 同源读数）" },
];

function sheetFor(t) {
	return `
任务：${t.id} 自由语言1:1复刻（不用尺规）

角色表：
  - 角色:worker pianist | 数量:1 | 沙箱:无 | 审链:评审员 | 指针:/root/brush-lab/tests/freehand/freehand-method.md
  - 角色:评审员 | 数量:1 | 沙箱:无 | 模型:zai-coding-cn/glm-5.3-flash

预算袋：时长 45 分钟

背景与边界：
工作区 /root/brush-lab/tests/${t.id}/（新建，全部产物进这里）。参考图 /root/brush-lab/references/refs/${t.ref}.jpg（${t.tribe}）。
自由语言单：禁用 src/canvas.py 尺规引擎——用纯 PIL/numpy 从零写绘画程序。允许 import PIL、numpy；禁止读参考图逐像素抄进画布（观察可以，逐像素复制不行——你写的是绘画程序不是解码器）。
禁网的墙不变：可以查 W3C 规范类知识（你本来就知道的），不得 clone 外部代码。

已知事实（省冷启动税——上一轮实验的沉淀，用不用随你，但用了要记进 references-external.md）：
- 画法书：/root/brush-lab/tests/freehand/freehand-method.md（上轮任务一 20+ 轮评审迭代的画法经验：观察法/分层画法/评审回路纪律）
- 观察工具：/root/brush-lab/tests/freehand/observe.py（分块/行/列/差值读数器，可直接用）
- 族基线：/root/brush-lab/references/tribe-freq-baseline.json（五族 high/slope 带宽——审图先查基线，判读自造图位置不在缺陷外）
- 上轮同款图的成绩单：copyfree-1（同 ref1fa0）blockMAE 1.31 全 lab 新纪录；freehand-3（任务三）终评中位 90%
- 残留施工（如在场）：${t.stock ?? "无"}

交付物清单：
- /root/brush-lab/tests/${t.id}/paint.py（绘画程序：可重跑，出图逐字节同）
- /root/brush-lab/tests/${t.id}/out.png（200x200）
- /root/brush-lab/tests/${t.id}/control.png（阴性对照：删主内容层只留底）
- /root/brush-lab/tests/${t.id}/iteration-log.md（每轮：改了什么+预期+读数）
- /root/brush-lab/tests/${t.id}/self-review.md（自评：构图/色调/质感三档+与参考图肉眼差距一句话）
- 桌面交付（画完的图给人看）：/root/brush-lab/tests/${t.id}/out.png 复制到 <user-home>/Desktop/pianist工具迭代/交付成果（命名时注明时间顺序）/，文件名 ${t.id}-YYYY-MM-DD-HHMM.png（YYYY-MM-DD-HHMM=复制时刻）

验收标准：
- out.png 200x200 面积非空；paint.py 重跑 sha256 逐字节同
- 阴性对照与参考图差异远大于成品与参考图差异
- iteration-log 至少 3 轮迭代记录（有读数）
- paint.py 单次运行 ≤5 秒
- 桌面交付文件在位（验收时 ls 确认）

纪律：
- brush-lab 非 git 仓：不 commit 不推
- 参考了外部实现或上轮沉淀，记 ${t.id}/references-external.md（无则写「无」）
- 评审员会是另一个分身（glm-5.3-flash），它会看你的交付物并给 VERDICT:pass/fail——你的自评要诚实，红项藏不住
- /tmp 调试残留别清
- 卡死 BLOCKED:环境: <原因>；完成 DONE <一句话清单>
`;
}

// —— 串行四单，可续跑：node copycat-v4-x4-dispatch.mjs copycat-v4-3 ——
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

	// —— 源3 消费方接线（本测核心）：施工分身退场 → 自动拉场景二收尾分身 ——
	let corpseDone = false;
	rt.sessionEndHook.register((ev) => {
		if (ev.outcome === "done" && !corpseDone) {
			corpseDone = true; // 一单一次（评审员退场不再重复拉）
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

	// 等收口：交货单×2（施工+评审）或讣告/发车失败
	const t0 = Date.now();
	const TIMEOUT = 55 * 60 * 1000; // 55min 总窗（预算 45min+余量）
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

	// 评审收口后多等 90s：收尾分身通常 2-4 分钟，不等它跑完（日志在 console）
	await new Promise((r) => setTimeout(r, 90 * 1000));
	rt.stop();

	// 收口摘要
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
fs.writeFileSync("/tmp/copycat-v4-summary.json", JSON.stringify(summary, null, 1));
console.log("wrote /tmp/copycat-v4-summary.json");
process.exit(0);
