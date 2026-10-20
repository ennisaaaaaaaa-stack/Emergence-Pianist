// copycat-v6-dispatch.mjs — 极坐标眼睛迭代单（10/18 晚，the user拍板）
// 单图：渐变流 6f31ec5c（v5-3 的迭代）。测点=pianist能否把「笛卡尔探针」升级成「匹配图生成逻辑的坐标系」。
// 已知事实给全（the user语义评审+the author极坐标验证），解法不给（坐标变换怎么落探针它自己想）。
// 0cbc（v5-4）几何关系问题挂账，等本单结果再定（the user判断同源）。
import { buildRuntime } from "/root/portalk-runtime/src/orchestrator/runtime.mjs";
import fs from "node:fs";
import { spawn } from "node:child_process";

const T = {
	id: "copycat-v6",
	ref: "6f31ec5cc28047737574081d3d1be87c",
	w: 1080, h: 1080,
	prev: "copycat-v5-3",
};

const sheet = `
任务：${T.id} 渐变流原生尺寸迭代·几何结构补课（不用尺规）

角色表：
  - 角色:worker pianist | 数量:1 | 沙箱:无 | 审链:评审员
  - 角色:评审员 | 数量:1 | 沙箱:无 | 模型:zai-coding-cn/glm-5.3-flash

预算袋：时长 60 分钟

背景与边界：
工作区 /root/brush-lab/tests/${T.id}/（新建，全部产物进这里）。参考图 /root/brush-lab/references/refs/${T.ref}.jpg（1080x1080 原生）。
上轮你的工件（迭代起点，不是从零重画）：/root/brush-lab/tests/${T.prev}/（paint.py/iteration-log.md 都在，上轮 pixel MAD 3.60/blockMAE 2.86）。
自由语言单：禁用 src/canvas.py 尺规引擎——纯 PIL/numpy。允许 import PIL、numpy；禁止逐像素抄参考图（观察可以，复制不行）。

已知事实（人类评审 + 仪器验证，本轮病灶定位——省你重新诊断，但解法自己想）：

人类评审对上轮成品的差评（原话要点）：
1. 原图对角线上下两个白色线条形成的空心圆，位置关系刚好对称，是画面的视觉锚点——上轮成品没有这两个锚点。
2. 原图波纹呈现四个同心圆结构，画面质感与这四个同心圆有关；光像被波纹扰动。
3. 最内两个同心圆范围内，光的渐变最柔和、几乎无噪点（干净核心）。
4. 第2~4个同心圆之间，光呈顺时针弯曲的规律波纹（涡旋区）。
5. 第四个同心圆外围，光呈放射状直线的扰动纹路（放射区）。
6. 整体：质感不是无规律的，是对称+渐进的几何美感——「光与扰动的反应」。上轮成品：色彩渐变还原了，但质感与光的关系没还原；纹理缺几何排列托着，看起来成了一摊摊色块（「像素低」感的来源之一）。

仪器验证（照着量过的，读数可信）：
- 原图亮度场绕画面中心转极坐标后，径向剖面梯度有 16px 周期的自相关——同心圆环结构物理存在。
- 上轮成品的径向峰位漂移（178/220/256/304 vs 原图 182/208/228）、无周期——纹理强度对了但排列随机。
- 上轮你的全部探针（行剖面/列剖面/分块）都是笛卡尔系的。关键：同心圆结构在行剖面里看起来就是波浪，只在极坐标下显形——测量坐标系与图的生成逻辑不匹配，是本轮病灶的根。
- 已排除项（别翻案除非有新证据）：细粒刻意偏低是 JPEG 损伤取舍（上轮判断维持）；色彩渐变已达标。

本轮目标：几何结构维度补课——锚点（对角空心圆对）、同心圆环排列（环位+环间距）、纹理各向异性随半径的渐变（内净→中涡旋→外放射）。目标读数：成品径向剖面自相关应出现与原图同量级的周期结构（原图 16px），或明确说明取舍理由。

交付物清单：
- /root/brush-lab/tests/${T.id}/paint.py（可重跑，出图逐字节同）
- /root/brush-lab/tests/${T.id}/out.png（1080x1080）
- /root/brush-lab/tests/${T.id}/control.png（阴性对照：删几何结构层——环/锚点/涡旋全去掉只留底+色彩渐变）
- /root/brush-lab/tests/${T.id}/iteration-log.md（每轮：改了什么+预期+读数——含径向结构读数）
- /root/brush-lab/tests/${T.id}/self-review.md（自评：锚点/环结构/各向异性渐变三档+与参考肉眼差距一句话）
- 桌面交付：out.png 复制到 <user-home>/Desktop/pianist工具迭代/交付成果（命名时注明时间顺序）/，文件名 ${T.id}-YYYY-MM-DD-HHMM.png

验收标准：
- out.png 1080x1080 非空；paint.py 重跑 sha256 逐字节同；单次运行 ≤15s
- 阴性对照与参考的差异远大于成品与参考（几何结构层是分数来源的证明）
- iteration-log 至少 3 轮，含径向结构读数（环位/周期对照原图）
- 色彩渐变维度不回退（上轮已达标项守住：pixel MAD ≤ 5）

纪律：
- brush-lab 非 git 仓：不 commit 不推
- 参考了外部实现或前人沉淀，记 ${T.id}/references-external.md（无则写「无」）
- 评审员是另一个分身（glm-5.3-flash），VERDICT:pass/fail——自评诚实，红项藏不住
- /tmp 调试残留别清
- 卡死 BLOCKED:环境: <原因>；完成 DONE <一句话清单>
`;

const rt = buildRuntime({ sheetText: sheet, cwd: "/root/portalk-runtime", shellUrl: "http://127.0.0.1:8770" });

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
const rec = rt.launchMinion({ taskId: T.id, role: "worker pianist" });
console.log(`spawn: ${rec.minionId} pid=${rec.pid}`);

const t0 = Date.now();
const TIMEOUT = 70 * 60 * 1000;
await new Promise((resolve) => {
	const iv = setInterval(() => {
		const msgs = rt.inbox.peekAll();
		const deliveries = msgs.filter((m) => m.kind === "交货单");
		const bad = msgs.filter((m) => m.kind === "讣告" || (m.kind === "通知" && String(m.text ?? "").includes("发车失败")));
		if (deliveries.length >= 2 || bad.length > 0 || Date.now() - t0 > TIMEOUT) {
			clearInterval(iv);
			resolve();
		}
	}, 5000);
});
await new Promise((r) => setTimeout(r, 90 * 1000));
rt.stop();

const msgs = rt.inbox.peekAll();
const deliveries = msgs.filter((m) => m.kind === "交货单");
const verdict = deliveries.find((m) => String(m.minionId ?? "").includes("-审-"))?.manifest?.verdict ?? null;
console.log(`${T.id} 收口: ${Math.round((Date.now() - t0) / 60000)}min 交货${deliveries.length} verdict=${verdict}`);
fs.writeFileSync("/tmp/copycat-v6-inbox.json", JSON.stringify(msgs, null, 1));
fs.mkdirSync("/root/portalk-runtime/data/copycat-v6", { recursive: true });
fs.writeFileSync("/root/portalk-runtime/data/copycat-v6/console-tail.txt", deliveries.map((d) => `${d.minionId} verdict=${d.manifest?.verdict ?? "-"}`).join("\n"));
process.exit(0);
