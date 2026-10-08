// test/orch-e2e-live.mjs — ⑧-2 live 真钱端到端（单跑专用，2026-10-07 第二铲待办#1）
//
// 是什么：真 spawn 真 pi（真钱，预算 <2 元）跑一个 fixture 小活，验证 ⑧-2 全链——
//   buildRuntime → RealDriver 真 spawn（柜供钥匙，context=orch:<taskId>/<minionId>，T16 首战）→
//   心跳遥测源喂 beat → 双时钟监督（总钟 5min 自预算袋推导）→ DONE 收尾泵 →
//   台账「收」+ 收件箱交货单 + 真 journal 落 use-vault 账。
// 与 stub 套件的区别：piBin 不指 stub（真身 bundle）；生产路径不隔离（真柜/真 journal/真遥测）——
//   live 验的就是生产链路，不是夹具链路（10/6 遥测钩子验收教训：开发链路绿≠生产链路绿）。
//
// 纪律：
//   - live-only，绝不挂 npm test（预检自证：package.json test 链无本文件名=零真钱回归的机械证）
//   - 只在the user在场时单跑：node test/orch-e2e-live.mjs
//   - 分身任务书钉死：只许写 /tmp/orch-e2e-live/，repo 零改动零 commit
//
// 判定（硬，任一红=FAIL）：①进程墙钟内退场且 exit 0+尾含 DONE；②台账「收」；
//   ③收件箱交货单在场；④hello.md 含 "orch e2e ok"+ISO 时间戳；
//   ⑤真 journal 新增 use-vault 行 context=orch:<taskId>/<minionId> 且账面无钥匙值。
// 判定（软，只报不断）：floorSummary / lastHeartbeat / 会话文件锁定数——遥测链活体证据，
//   链路抖动单独报不连坐核心判定（已知缺口：真实 pi 会话文件在 sessions/<cwd-sanitized>/
//   子目录，watcher 只扫一层——源① live 下预期锁 0 文件，心跳走遥测源②）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = "/tmp/orch-e2e-live";
const MINION = "m-e2e-live";
const taskId = `orch-e2e-live-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}Z`;

let pass = 0, total = 0;
const fails = [];
function check(name, ok, extra) {
	total++;
	if (ok) pass++; else fails.push(name);
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${!ok && extra !== undefined ? ` — ${extra}` : ""}`);
}
function info(name, ok, extra) {
	console.log(`${ok ? "[info-ok]" : "[info-gap]"} ${name}${extra !== undefined ? ` — ${extra}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 0) 预检（花真钱前把已知死法全拦下；任一红→不发车，零花费）----
console.log(`== live-e2e 预检 ${new Date().toISOString()} taskId=${taskId} ==`);
const pkg = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
check("预检：live 不挂 npm test（test 链无本文件名=零真钱回归机械证）",
	!JSON.stringify(pkg.scripts).includes("orch-e2e-live"));
check("预检：ORCH_PI_BIN 未设（设了会指 stub，live 必须真身）", !process.env.ORCH_PI_BIN);
const VAULT_DIR = process.env.PORTALK_CRED_DIR ?? path.join(os.homedir(), ".portalk", "credentials");
const JOURNAL = process.env.PORTALK_CRED_JOURNAL ?? path.join(REPO, "data", "cred-journal.jsonl");
check("预检：钥匙柜有 coding-plan（走 use-vault 正路，不走 env 回落）",
	fs.existsSync(path.join(VAULT_DIR, "coding-plan")));
{
	let status = -1;
	try {
		const res = await fetch("http://127.0.0.1:8770/health");
		status = res.status;
	} catch { status = -1; }
	check("预检：壳 8770 在场（/health 200）——遥测源②的落盘方，不在场则心跳只剩死路", status === 200, `HTTP ${status}`);
}
if (fails.length > 0) {
	console.log(`\n== 预检未过（${fails.length} 红）——不发车，零花费 ==`);
	process.exit(1);
}

const countOrchJournal = () => {
	if (!fs.existsSync(JOURNAL)) return 0;
	return fs.readFileSync(JOURNAL, "utf8").split("\n")
		.filter((l) => l.trim() && JSON.parse(l).action === "use-vault" && String(JSON.parse(l).context ?? "").startsWith("orch:"))
		.length;
};
const journalBefore = countOrchJournal();

// ---- 1) 夹具：输出目录净场 ----
fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });

// ---- 2) 任务书（casting sheet v0：角色表/预算袋/验收标准三必填）----
const sheetText = `# live 端到端验收夹具书
背景与边界：编排器 live 验收用的小活——唯一目的是证明编排链路真钱可用。只许写 /tmp/orch-e2e-live/ 下的文件，repo 与家目录零改动。
预算袋：时长 5 分钟
角色表：
  - 角色:施工分身 | 数量:1 | 沙箱:无
交付物清单：
  - /tmp/orch-e2e-live/hello.md：恰好两行——第一行固定文本 orch e2e ok，第二行写完成时刻的 ISO 8601 时间戳
验收标准：
  - hello.md 第一行是 orch e2e ok，第二行是 ISO 8601 时间戳（形如 2026-10-07T15:04:05Z）
  - 全部做完后最后一个输出行必须是 DONE
纪律：
  - 不 commit；做完即退出，不做任何额外探索`;

const { buildRuntime } = await import("../src/orchestrator/runtime.mjs");
const rt = buildRuntime({ sheetText, cwd: REPO });

const entry = rt.driver.resolvePiEntry();
check("发车前：pi 入口=真身 bundle（非 stub）",
	entry.includes(path.join("node_modules", "@earendil-works")) && !entry.includes("stub"), entry);

console.log(`\n== 发车（真钱开计）${new Date().toISOString()} ==`);
const t0 = Date.now();
const rec = rt.launchMinion({ taskId, role: "施工分身", minionId: MINION });
console.log(`spawn：${rec.minionId} pid=${rec.pid} tier=${rec.tier} entry=${path.basename(entry)}`);
rt.startLoop(500); // 生产常驻 tick：poll→tick→sweep（第二铲接口，live 首跑）

// 墙钟帽=总钟 5min + 宽限 + 观察余量；引擎到点自己杀，脚本只兜底不抢
const wallCapMs = 5 * 60_000 + 60_000;
let exit = null;
while (Date.now() - t0 < wallCapMs) {
	const r = rt.driver.rows.get(MINION);
	if (r?.done) { exit = r.exit; break; }
	await sleep(250);
}
rt.stop();
const elapsedS = Math.round((Date.now() - t0) / 1000);
console.log(`\n== 退场 ${elapsedS}s ==\n--- tail（末 300 字）---\n${(exit?.tail ?? "(无)").slice(-300)}\n--------------------`);

// ---- 3) 硬判定 ----
check("硬①：进程墙钟内退场且 exit=0 且尾含 DONE（收尾泵的活形状）",
	exit != null && exit.code === 0 && /(^|\n)\s*DONE\b/.test(exit.tail),
	`code=${exit?.code} signal=${exit?.signal}`);

const row = rt.ledger.get(MINION);
check("硬②：台账「收」", row?.status === "收", `status=${row?.status}`);

const item = rt.inbox.items.find((i) => i.payload?.minionId === MINION);
check("硬③：收件箱交货单在场（kind=交货单）", item?.kind === "交货单");

{
	const deliverable = path.join(OUT_DIR, "hello.md");
	let text = null;
	try { text = fs.readFileSync(deliverable, "utf8"); } catch { /* 缺席在下条断言红 */ }
	check("硬④：hello.md 在场且含 orch e2e ok + ISO 时间戳",
		text != null && text.includes("orch e2e ok") && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text),
		text == null ? "文件缺席" : JSON.stringify(text));
}

{
	const lines = fs.existsSync(JOURNAL)
		? fs.readFileSync(JOURNAL, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
		: [];
	const use = lines.filter((l) => l.action === "use-vault" && l.context === `orch:${taskId}/${MINION}`);
	const vaultValue = fs.readFileSync(path.join(VAULT_DIR, "coding-plan"), "utf8");
	const journalText = fs.readFileSync(JOURNAL, "utf8");
	check("硬⑤a：真 journal 新增 use-vault（context=orch 任务级粒度，T16 首战）",
		use.length >= 1 && use.every((l) => l.name === "coding-plan"),
		`新增 ${use.length} 行（before=${journalBefore} after=${countOrchJournal()}）`);
	check("硬⑤b：账面无钥匙值（只有名字没有值）", !journalText.includes(vaultValue));
}

// ---- 4) 软指标（只报不断：遥测链活体证据 + 已知缺口出声）----
info("软：遥测链活着（lastHeartbeat 已登记——源②真喂）", row?.lastHeartbeat != null,
	row?.lastTool ? `lastTool=${row.lastTool}` : "无心跳记录");
const manifest = item?.payload?.manifest ?? null;
info("软：交货单带地板摘要（floorSummary 从遥测机械抽取）", manifest?.floorSummary != null,
	manifest?.floorSummary ? `testStatus=${manifest.floorSummary.testStatus ?? "-"} currentTool=${manifest.floorSummary.currentTool ?? "-"}` : "缺席");
const locked = rt.watcher.locked(MINION);
info("软：会话源①锁定文件数（已知缺口：真实 pi 会话在 <cwd-sanitized>/ 子目录，watcher 只扫一层，预期 0）",
	locked.length > 0, `locked=${locked.length}`);

// ---- 5) 判决 ----
console.log(`\n== LIVE-E2E ${fails.length === 0 ? "PASS" : "FAIL"}：${pass}/${total} 硬断言绿，用时 ${elapsedS}s，journal orch: 账 ${journalBefore}→${countOrchJournal()} ==`);
if (fails.length > 0) console.log(`红项：\n- ${fails.join("\n- ")}`);
process.exitCode = fails.length === 0 ? 0 : 1;
