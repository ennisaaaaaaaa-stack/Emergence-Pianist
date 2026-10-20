// freehand-orig-1-dispatch.mjs — pianist自由创作首单（10/18 深夜，the user出题「龙舌兰日落」）
// 与 copycat 系的本质区别：无参考图。pianist拿到的是四个字，其余全靠它自己。
// 测点：①原创能力（构图/色彩/质感从零组织）②手艺内化——临摹学来的引擎（连续场/锁相环/feather/颗粒纪律）
//   会不会在自由创作时自发流出（零指针，翻不翻 spoor 自己定）③语义层评审首秀（无 MAD 可对，评审员盲评主题契合）
// 评审：审链照旧 5.3-flash，但验收从「对参考图差」换成「语义契合+画法自证」；the user人眼终审。
import { buildRuntime } from "/root/portalk-runtime/src/orchestrator/runtime.mjs";
import fs from "node:fs";
import { spawn } from "node:child_process";

const T = { id: "freehand-orig-1", theme: "龙舌兰日落", w: 1080, h: 1080 };

const sheet = `
任务：${T.id} 自由创作——「${T.theme}」（不用尺规）

角色表：
  - 角色:worker pianist | 数量:1 | 沙箱:无 | 审链:评审员
  - 角色:评审员 | 数量:1 | 沙箱:无 | 模型:zai-coding-cn/glm-5.3-flash

预算袋：时长 50 分钟

背景与边界：
工作区 /root/brush-lab/tests/${T.id}/（新建，全部产物进这里）。
这是一张原创：没有参考图。主题只有四个字——「${T.theme}」。它意味着什么（龙舌兰的形？龙舌兰酒的色彩？日落的光？还是别的联想），由你解释；解释要写进 self-review。构图、色彩、质感、画法全部你定。
尺寸 ${T.w}x${T.h}。自由语言单：禁用 src/canvas.py 尺规引擎——纯 PIL/numpy。允许 import PIL、numpy。
你以前的画法家底（如有用得上的，随意；用没用都记进 references-external.md）。

评审方式（与临摹不同，如实说明）：
- 无参考图，没有 MAD 可对。评审员拿到你的画与主题，评三样：主题契合（这画能不能读出「${T.theme}」）、构图（视觉层次/锚点/平衡）、质感（光的处理、纹理有没有章法）。
- 人类终审：画会送到人类评审（她出题）。她评的是「像不像一幅值得挂起来的画」，不是「像不像某张图」。

交付物清单：
- /root/brush-lab/tests/${T.id}/paint.py（可重跑，出图逐字节同）
- /root/brush-lab/tests/${T.id}/out.png（${T.w}x${T.h}）
- /root/brush-lab/tests/${T.id}/iteration-log.md（至少 2 轮：改了什么+为什么+读数——读数自造，能量化你的取舍就行）
- /root/brush-lab/tests/${T.id}/self-review.md（必须包含：你对「${T.theme}」的解读一段；构图元素清单及各自的作用；你用了哪些手艺、从哪来的）
- 桌面交付：out.png 复制到 <user-home>/Desktop/pianist工具迭代/交付成果（命名时注明时间顺序）/，文件名 ${T.id}-YYYY-MM-DD-HHMM-<你的自起名>.png（给画起个名字，人类想看pianist起的名字）

验收标准：
- out.png ${T.w}x${T.h} 非空；paint.py 重跑 sha256 逐字节同；单次运行 ≤15s
- self-review 的主题解读段在场（评审员要拿它对照画面）
- iteration-log 至少 2 轮
- 评审员 VERDICT 三维均不红（主题契合/构图/质感）

纪律：
- brush-lab 非 git 仓：不 commit 不推
- 参考了外部实现或前人沉淀，记 ${T.id}/references-external.md（无则写「无」）
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
const TIMEOUT = 60 * 60 * 1000;
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
fs.writeFileSync("/tmp/freehand-orig-1-inbox.json", JSON.stringify(msgs, null, 1));
fs.mkdirSync("/root/portalk-runtime/data/freehand-orig-1", { recursive: true });
fs.writeFileSync("/root/portalk-runtime/data/freehand-orig-1/console-tail.txt", deliveries.map((d) => `${d.minionId} verdict=${d.manifest?.verdict ?? "-"}`).join("\n"));
process.exit(0);
