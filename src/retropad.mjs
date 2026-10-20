#!/usr/bin/env node
/**
 * retropad — 复盘分身拉起器 v2（v2-2 收编编排器，2026-10-10；前身 v1 2026-09-21 施工③第三步）
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
 * v2-2 收编编排器（本版）：
 *   - 拉起走 buildRuntime + launchMinion（内联任务书，角色=复盘分身）——spawn 进台账、
 *     心跳双源（会话 mtime + 遥测 tail）经 watcher 喂 ledger、双时钟看门在环、
 *     收尾走收件箱（DONE→交货单 / BLOCKED→通知 / 暴死→讣告）。
 *   - 触发器三源（retro-trigger.mjs）：热点阈值 / 抽检到期（状态文件）/ 收尾钩子（--hook）。
 *     三源全不满足 → 不拉分身（合法收工）；--force 跳闸（手动直拉位）。
 *   - 裁决提取：旧「stdout 尾部 JSON 扫描」改为「交货单 manifest.tail 提取」——
 *     形状校验（verdict 字段）与旧版一致；candidate 投 Grimoire 链路原样。
 *   - 合法收工（nothing / dry-run / 投递全成）写复盘状态文件（lastRetroAt）——抽检到期源读它。
 *
 * 沙箱诚实降级（v2-2）：蓝图 §5 角色卡 = workspace-write + 禁外网（映射编排器 no-ext-net 档）。
 *   但 v0 编排器沙箱路径不回收 stdout（executor stdio=inherit，交货单 manifest.tail 无从采集），
 *   裁决交货链在沙箱档下结构性断路——本版任务书沙箱列=「无」（直 spawn，台账如实记 tier=null），
 *   降级出声不装沙箱；executor 支持 stdout 回收后把列改回「workspace-write禁外网」即切真档。
 *
 * 可拆卸性：独立进程，不在pianist会话进程树里。它挂了 = 自学习停摆，会话主干无感。
 * 触发：手动（--force）/ cron / session 收尾钩子（--hook）/ 触发器三源——都只是 exec 本文件。
 *
 * v2-2.1 infra 工单出口（2026-10-11，the author）：
 *   - 首战实录（retro-20261010-173713）：分身正确把桥面错误簇归因为「环境传感非认知浪费、
 *     修复在基础设施层」，但 verdict 只有 nothing/candidates 两出口——工单死在 note 一句话里。
 *   - 第三出口 tickets：可与任意 verdict 共存；落 tickets.jsonl（append-only，title 去重幂等，
 *     status=open 待消费）。去向：pianist领单修（定位→修复→下轮扫描验证热点消失）——闭环从
 *     「裁决」延到「解决」。v0 去重只看 title 不看 status：修完再犯起新名或消费方改 status。
 *
 * v3 三修+收尾分身（2026-10-17 t16-fix，图纸 spoor 档案 76b28732447b）：
 *   - 批次上限 ≤5（lastTs 旧先盘）——11 个塞一场是首死直接原因（10-16 23:46 SIGTERM code143）；
 *     上一场 verdict=failed → 本场批次自适应减半（floor(5/2^failStreak)，下限 1）。
 *   - 超时按批次缩放：timeout = 180 + 60×批数（批 5→480s、批 1→240s）；显式 --timeout 仍是测试直拉位。
 *   - 死亡落账：非法收工也写 state（verdict=failed+failStreak），due 源不空转；连续两死出声报修。
 *   - 收尾分身（场景二 task-scoped，--session 在场时）：prompt 升级为「三问+读 session 全文+三路分流」
 *     ——spoor 路（mark 数据/判断）与坑区路（mark 坑）经 pianist_bridge spoor_journal 实装，
 *     tideline 路留位静默跳过（空库未接，禁造写入调用）；写入闸门：值得才写，没有就静默。
 *
 * 用法：
 *   node src/retropad.mjs [--report data/hotspots/latest.json] [--agent pianist-dev-1]
 *                         [--timeout <秒>] [--dry-run] [--force] [--hook] [--session <尸体session文件>]
 *                         [--project <spoor项目名>] [--state data/retro/state.json] [--threshold 3]
 *                         [--interval 21600000] [--tickets data/retro/tickets.jsonl]
 *   --dry-run：不投Grimoire，只打印分身的裁决 JSON（调试用）。
 *   --force  ：跳过触发器闸（手动直拉位——触发器说了算的世界里给人工留的口子，出声）。
 *   --hook   ：session 收尾钩子路径拉起（触发器源3 hookFired=true——runtime completionPump fire 侧）。
 *   --session：收尾分身的尸体 session 全文路径（场景二尸体复盘；通常配 --hook；在场时零热点不早退
 *              ——成功路径沉淀不在错误传感器视野，零热点也值得尸体复盘一趟）。
 *   --project：三路分流 spoor 路的 journal 项目名（缺省 portalk——本仓自身的猎迹工作台）。
 * 退出码：0=分身正常收工（含「没有值得记的」/触发器不满足/零热点且无尸体）；2=报告不可读/形状坏；3=分身超时/失败。
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { buildRuntime } from "./orchestrator/runtime.mjs";
import {
	evaluateRetroTrigger,
	readRetroState,
	writeRetroState,
	isLiveShape,
	DEFAULT_HOTSPOT_THRESHOLD,
	DEFAULT_RETRO_INTERVAL_MS,
} from "./orchestrator/retro-trigger.mjs";

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
const AGENT = arg("agent", "pianist-dev-1"); // v1 遗留位（现无人消费，保留兼容既有调用方）
// 超时（v3 三修②）：缺省按批次缩放 timeout = 180 + 60×批数（批 5→480s、批 1→240s）——固定 240s
// 装 11 热点是首死直接原因（10-16 23:46 SIGTERM code143）。批数在读完报告后才知，公式值在切片后算；
// 显式 --timeout 是测试直拉位（钟下限 5s：编排器双时钟接管超时收尾后，短钟是合法测试位）。
const TIMEOUT_ARG_RAW = arg("timeout", null);
const DRY = args.includes("--dry-run");
const FORCE = args.includes("--force");
const HOOK = args.includes("--hook");
const SESSION_FILE = arg("session", ""); // 收尾分身（场景二）：尸体 session 全文路径（通常配 --hook）
const SPOOR_PROJECT = arg("project", "portalk"); // 三路分流 spoor 路的 journal 项目名（缺省本仓工作台）
const STATE = arg("state", "data/retro/state.json");
const TICKETS = arg("tickets", "data/retro/tickets.jsonl"); // infra 工单落账（v2-2.1 第三出口）
const THRESHOLD = Number(arg("threshold", String(DEFAULT_HOTSPOT_THRESHOLD)));
const INTERVAL = Number(arg("interval", String(DEFAULT_RETRO_INTERVAL_MS)));
if (!Number.isFinite(THRESHOLD) || THRESHOLD < 1 || !Number.isFinite(INTERVAL) || INTERVAL < 1) {
	console.error(`[retropad] 触发器参数非法：threshold=${arg("threshold", "?")} interval=${arg("interval", "?")}（都必须 ≥1）`);
	process.exit(2);
}
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

// ---------------------------------------------------------------------------
// 批次上限（v3 三修①）+ 超时公式（三修②）+ 死亡减载：状态账提前读（失败落账喂减半，触发器闸共用）
// ---------------------------------------------------------------------------
const retroState = readRetroState(path.resolve(CWD, STATE));
const failStreak = retroState.raw?.verdict === "failed" ? Math.max(1, Number(retroState.raw.failStreak) || 1) : 0;
// 批次上限：一次盘 ≤5 热点（v3 定案）——11 个塞一场是首死直接原因（10-16 23:46 threshold fire→240s SIGTERM code143）
const MAX_PER_RUN = 5;
// 死亡落账的消费面（v3 三修③）：上一场 verdict=failed → 本场批次自适应减半（floor(5/2^failStreak)，下限 1）
const maxPerRun = Math.max(1, Math.floor(MAX_PER_RUN / 2 ** failStreak));
if (failStreak > 0) {
	console.log(`[retropad] 上一场失败落账在场（verdict=failed，连续 ${failStreak} 场）——本场批次自适应减半：${MAX_PER_RUN}→${maxPerRun}`);
	if (failStreak >= 2) console.error(`[retropad] 报修：连续 ${failStreak} 场复盘死亡——retropad/复盘分身管线需要人看（批次减半救不了环境病，冷却再战也是空转）`);
}
// lastTs 旧先盘（v3 原话）：旧账优先——新事留在热池里给下一场，旧账再不盘就永远没人盘
const byOldestLastTs = (a, b) => {
	const ta = Date.parse(a?.lastTs ?? "");
	const tb = Date.parse(b?.lastTs ?? "");
	const va = Number.isFinite(ta) ? ta : Number.POSITIVE_INFINITY; // 缺/坏 lastTs 排队尾（年龄不明不插队）
	const vb = Number.isFinite(tb) ? tb : Number.POSITIVE_INFINITY;
	return va - vb;
};
const hotspots = [...report.hotspots].sort(byOldestLastTs).slice(0, maxPerRun);
const errorHotspots = [...report.errorHotspots].sort(byOldestLastTs).slice(0, maxPerRun);
if (report.hotspots.length > hotspots.length || report.errorHotspots.length > errorHotspots.length) {
	console.log(`[retropad] 热点超批次上限：重复 ${report.hotspots.length}→${hotspots.length}、错误 ${report.errorHotspots.length}→${errorHotspots.length}（上限 ${maxPerRun}${failStreak > 0 ? "，失败减半后" : ""}，lastTs 旧先盘）——剩下的留给下次`);
}

// 超时公式（v3 三修②）：timeout = 180 + 60×批数（批 5→480s、批 1→240s）；显式 --timeout 是测试直拉位
const batchN = hotspots.length + errorHotspots.length;
const TIMEOUT = TIMEOUT_ARG_RAW != null
	? Math.max(5, parseInt(TIMEOUT_ARG_RAW, 10) || 180 + 60 * batchN)
	: 180 + 60 * batchN;
console.log(`[retropad] 超时：${TIMEOUT_ARG_RAW != null ? `显式 ${TIMEOUT}s（测试直拉位）` : `公式 180+60×${batchN}=${TIMEOUT}s（v3 三修②）`}`);

if (hotspots.length === 0 && errorHotspots.length === 0 && !SESSION_FILE) {
	// 零热点 = 没有事件就没有分身（闸门三）：不拉 pi，直接收工。
	// 收尾分身例外（v3 场景二）：--session 在场时零热点不早退——成功路径沉淀不在错误传感器视野，
	// 尸体复盘读 session 全文，不是只读热点。
	console.log(`[retropad] 报告零热点（${REPORT}）——没有事件就没有进程，分身不拉起`);
	process.exit(0);
}

// ---------------------------------------------------------------------------
// draft 近亲名单（洞4，collaborator A #708 裁决「输入侧补，补的是名字不是名录」）：
// 经图不动、409 不动、巡山兜底不动——只在分身输入侧给 draft 一行名录。
// 数据源 = Grimoire /darkzone（draft 从未被 push/expand，天然在暗区名单里，[layer/status] 可过滤）。
// 失败必须出声降级：拉不到名单 ≠ 名单为空，蒙眼判案比瞎猜近亲更糟的是「以为没有近亲」。
// 放在触发器闸之前：名单拉取是输入面组装（日志形状稳定），闸门只管拉不拉分身。
// ---------------------------------------------------------------------------
let draftRoster = null; // null=拉取失败（出声降级）；""=无 draft；非空=逐个名字缩写
try {
	const res = await fetch(`${SHELL_URL}/tools/invoke`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action: "grimoire_darkzone", agent: "retropad-1" }),
	});
	const data = await res.json();
	const text = typeof data?.body === "string" ? data.body : JSON.stringify(data?.body ?? data);
	// 行形状：name  [layer/status]；draft 行 = status 为 draft
	const drafts = [];
	for (const line of text.split("\n")) {
		const m = line.match(/^(\S+)\s+\[(\S+)\/(\S+)\]/);
		if (m && m[3] === "draft") drafts.push(m[1]);
	}
	draftRoster = drafts.map((n) => abbreviate(n)).join(", ");
	console.log(`[retropad] draft 近亲名单：${drafts.length} 本（${draftRoster || "无"}）`);
} catch (e) {
	console.warn(`[retropad] draft 名单拉取失败——分身将看不到近亲（查重照做，但 409 挡不住的近亲这轮防不了）：${e.message}`);
}

// 既有工单名单（2026-10-15 wander，工单#1≠#4同根因复盘）：同名去重的前提是裁决者知道旧名单——
// 任务书纪律第7条要求「稳定工单名」，但分身从来看不到 tickets.jsonl，只能发明新名→同根因双单。
// 读盘注入 open 名单（读不到出声降级，盲判比空名单更糟的是「以为没有旧单」）。
let openTickets = null; // null=读失败；[] = 无；非空 = {title, detail}[]
try {
	const tp = path.resolve(CWD, TICKETS);
	if (fs.existsSync(tp)) {
		openTickets = [];
		for (const line of fs.readFileSync(tp, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				const t = JSON.parse(line);
				if (t?.status === "open" && typeof t.title === "string" && t.title.trim()) {
					openTickets.push({ title: t.title.trim(), detail: String(t.detail ?? "").slice(0, 120) });
				}
			} catch { /* 坏行不拒名单（append-only 日志） */ }
		}
	}
	if (openTickets !== null) console.log(`[retropad] 既有工单 open 名单：${openTickets.length} 张（${openTickets.map((t) => t.title).join("; ") || "无"}）`);
} catch (e) {
	console.warn(`[retropad] 既有工单名单读失败——分身将看不到旧单（同名去重退化，可能再出同根因新名单）：${e.message}`);
}

/** 洞4 缩写（collaborator A #708：「数量+名字缩写（首词+hash前4）」）：hash 前缀用名字首词的确定性短哈希 */
function abbreviate(name) {
	let h = 0;
	for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return `${name.split("-")[0]}~${h.toString(16).slice(0, 4)}`;
}

// ---------------------------------------------------------------------------
// 触发器闸（v2-2 第一铲接线）：三源全不满足 → 不拉分身（零事件零进程，合法收工）
// ---------------------------------------------------------------------------

const trig = evaluateRetroTrigger({
	report,
	threshold: THRESHOLD,
	lastRetroAt: retroState.lastRetroAt,
	intervalMs: INTERVAL,
	hookFired: HOOK,
	now: Date.now(),
});
console.log(`[retropad] 触发器：fire=${trig.fire} reason=${trig.reason}（state=${retroState.source}）—— ${trig.detail}`);
if (!trig.fire && !FORCE) {
	console.log(`[retropad] 触发器不满足——复盘分身不拉起（合法收工，不耗分身预算）`);
	process.exit(0);
}
if (FORCE) console.log(`[retropad] --force：跳过触发器闸（手动直拉位）`);

// ---------------------------------------------------------------------------
// 组装分身输入（指针+结论，不给全文）——落临时指针文件，任务书角色表引用它
// ---------------------------------------------------------------------------

const hotBrief = hotspots.map((h, i) => {
	const ev = `${h.evidence.file}#${h.evidence.line}..${h.evidence.lastLine}`;
	const liveMark = isLiveShape(h, retroState.lastRetroAt) ? "裁决后新事=有" : "裁决后新事=无";
	return `${i + 1}. [重复] agent=${h.agent} ×${h.occurrences} 收敛度=${h.convergence} 序列=[${h.windowFp}] 执行形状=${h.topExecShape} 首末=${h.firstTs}~${h.lastTs} ${liveMark} 证据指针=${ev}`;
});
const errBrief = errorHotspots.map((e, i) => {
	const evs = e.evidence.map((x) => `${x.file}#${x.line}`).join(", ");
	const liveMark = isLiveShape(e, retroState.lastRetroAt) ? "裁决后新事=有" : "裁决后新事=无";
	return `${i + 1}. [错误] agent=${e.agent} ×${e.count} 形状=${e.shape} 首末=${e.firstTs}~${e.lastTs} ${liveMark} 证据指针=${evs}`;
});

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "retropad-")); // 指针文件一次性（prompt 组装时已消费），跑完即清
const inputFile = path.join(workDir, "retro-input.md");
// 收尾分身段（v3 场景二，t16-fix 活2）：--session 在场时升级为「三问+读 session 全文+三路分流」。
// spoor 路（mark 数据/判断）与坑区路（mark 坑）经 pianist_bridge spoor_journal 实装；
// tideline 路留位静默跳过（空库未接，禁造写入调用）；写入闸门照 v3「值得才写，没有就静默」。
const corpseSection = SESSION_FILE ? `
## 收尾分身：尸体复盘（场景二 task-scoped——本段在场时你就是收尾分身）

读 session 全文：${SESSION_FILE}（用 read 工具分段读完整个文件——不是只读热点：成功路径的沉淀不在错误传感器视野里，errorHotspots 只看得见错的）。

三问（对整场 session 逐一路过，答完再动笔）：
1. 编译掉的是什么判断——这场有「重复×确定×无新判断」可编译的步骤吗？
2. 为何不心疼——JP 降权签名在哪（判断已被机械面接住的证据）？
3. 何时交回判断——适用条件/必须上浮的情形是什么？

三路分流（第一闭环写入——成功路径沉淀照写，不只记错）：
- spoor 路（实装）：本场工作痕迹值得下一代冷启动复用的，写 spoor journal——工作为主、非第一人称，按 spoor journal 格式 mark 数据/判断：
  {action:"spoor_journal", payload:{project:"${SPOOR_PROJECT}", entry:"<一句话工作记录，非第一人称>", mark:"数据"}}（判断类用 mark:"判断"）
- 坑区路（实装）：踩坑=事故驱动信号（错了才记）——同路写 spoor journal，mark 用「坑」：
  {action:"spoor_journal", payload:{project:"${SPOOR_PROJECT}", entry:"<一句话坑：现象+根因+下次怎么避>", mark:"坑"}}
- tideline 路（留位静默跳过）：质感叙事——tideline 库未接（空库），本场静默跳过，禁造任何 tideline 写入调用。

写入闸门（v3 原话照搬闸门二）：值得才写，没有就静默——三路都没有值得写的，verdict=nothing 收工，不为交差硬造。
（判断纪律#4 的「只有读面」在收尾分身场景放宽一格：spoor_journal 写面经同一桥，读 session 全文用文件 read——除此之外不新增工具。）
` : "";
fs.writeFileSync(inputFile, `# 复盘分身任务输入（闸门一：预处理过的热点摘要——结论+指针，不给原始日志）

## 热点摘要（重复性和确定性已由扫描器机械判过，不用你判）

每条热点带「裁决后新事」标记（=有/=无，判定与触发器同源）：有=上次合法裁决后该形状仍有新事件（活——优先重想）；无=裁决后零新事件（旧账——对同一份证据重复推导正是本闭环要编译掉的浪费，除非你有新视角（如新证据推翻旧根因），维持原判即可，别为交差硬造）。

重复热点（指纹×次数×收敛度）：
${hotBrief.join("\n") || "（无）"}

错误热点（同形状失败聚合）：
${errBrief.join("\n") || "（无）"}
${corpseSection}
## 判断纪律

1. 「本场没有值得记的」是合法输出，且应是多数情况。不要为了交差硬造 candidate。
2. 机械两维已经过阈——你要判的是它们判不了的：这个重复是「值得保留的判断被机械重复」还是「本可编译掉的搬运」？错误热点值得记的判据是「同类失败反复出现且没有既有 capability 接住」。
3. 每个 candidate 必须能回答：编译掉的是什么判断、为何不心疼（JP 降权签名）、何时交回判断（适用条件/必须上浮的情形）。
4. 你只有一个工具 pianist_bridge（action=payload 形如 {action:"grimoire_map", payload:{}}），只能读Grimoire的经图查重——已有 capability 直接复用，不重复提交。
5. 健康检查：经图中无你产出过的资产则跳过（author=retropad-1 的条目为零时，健康问整段跳过，verdict 里的 health 填 "n/a"）。
6. 近亲防撞：待审区已有 draft ${draftRoster === null ? "（名单拉取失败，本轮近亲盲判——candidate 名字更要保守）" : `（${draftRoster || "无"}）`}。409 只挡同名不挡近亲——起名前先对照上面这行，名字撞上近亲变体就换名或改投「复用既有 draft」的理由。
7. infra 工单出口：错误热点若定位为基础设施/环境层问题（非认知浪费、修复在壳/桥/编排层而非经图），放 tickets 数组——每单 {"title","detail","evidence"}：detail=一句话根因+修复方向，evidence=证据指针。tickets 可与任何 verdict 共存（nothing 也能带工单收工）。title 纪律：落单前先对照输入末尾「既有工单 open 名单」——同根因（哪怕措辞不同、证据重叠）必须复用既有 title 原文，同名去重才接得住（v0 去重只看 title 不看语义）；真新根因才起新名，起了就别改。
8. candidate 起名一律 auto/ 前缀（如 auto/xxx）：这是四道闸的入口条件——非 auto 名字会被壳侧当普通提交挂人工审批（red），你的书进不了新兵区也就永远不会被注入。名字前缀不对=白写。
9. 产出格式：裁决 JSON 放最后一个 message 的末尾（在收工协议 DONE 行之前），其余解释文字放前面：
   {"verdict":"nothing"|"candidates", "health":"ok"|"n/a"|"issues:<一句话>", "candidates":[...], "tickets":[{"title","detail","evidence"}]（可省）, "note":"一句话收工说明"}

先查经图，再下裁决。

## 既有工单（tickets.jsonl open 名单——同根因必须复用其 title 原文）

${openTickets === null ? "（名单读取失败，本轮旧单盲判——非确信新根因就别起新名）" : openTickets.map((t) => `- ${t.title}${t.detail ? ` —— ${t.detail}` : ""}`).join("\n") || "（无）"}`);

// ---------------------------------------------------------------------------
// 内联任务书（蓝图 §5 复盘分身角色卡落位；沙箱列见文件头「沙箱诚实降级」注记）
// ---------------------------------------------------------------------------

const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").replace(/\..+/, "");
const taskId = `retro-${stamp}`;
const sheetText = `# 复盘任务书（${taskId}·触发=${trig.reason}·热点=${hotspots.length}+${errorHotspots.length}）
背景与边界：自学习双闭环的第三维判断——机械扫描（重复性×确定性）已过阈的热点，由你判「认知浪费」这最后一维：这步骤还值不值得一个会推理的主体重新想一遍。本任务书由 retropad 内联生成（EP-自学习闭环v2提案 §5 复盘分身角色卡）。沙箱：角色卡=workspace-write禁外网（no-ext-net 档）；现状（10/18 复核）：stdout 已回收（7b04eec），但沙箱内连不上桥（netns 内 8770 不可达=查不了经图/spoor）——本跑走直 spawn（沙箱列=无，出声降级），gate-proxy 加 shell.internal 保留域（照 vault.internal 形状）后切真档。
预算袋：时长 ${Math.max(1, Math.round(TIMEOUT / 60))} 分钟
角色表：
  - 角色:复盘分身 | 数量:1 | 沙箱:无 | 指针:${inputFile}
交付物清单：
  - 裁决 JSON：{"verdict":"nothing"|"candidates", "health":"ok"|"n/a"|"issues:<一句话>", "candidates":[...], "tickets":[{"title","detail","evidence"}]（可省）, "note":"一句话收工说明"}
验收标准：
  - 「本场没有值得记的」是合法输出且应是多数——不为交差硬造 candidate
  - verdict=candidates 时列表非空，且逐个能答三问（编译掉什么判断/为何不心疼/何时交回判断）
  - tickets（若有）逐单能答：根因是什么、为什么修复在基础设施层不在经图
纪律：
  - 先查经图（pianist_bridge 只读面）再下裁决；近亲防撞；健康问照答
  - 裁决 JSON 放最后一个 message 末尾，随后按收工协议收行`;

// ---------------------------------------------------------------------------
// 拉起分身（闸门三：跑完即退；v2-2 走编排器——台账/心跳双源/双时钟看门/收件箱交货全链）
// ---------------------------------------------------------------------------

// 钥匙柜供给：驱动器 envOrVault("ZAI_CODING_CN_API_KEY","coding-plan",`orch:${taskId}/${minionId}`)
// ——context 带 retropad 标识（taskId 以 retro- 起），journal 记到任务级粒度（拍板表#3）。
// 遥测不关：心跳源②（遥测 tail）靠它喂台账——复盘分身自己的循环会以 orch-* agent 落遥测，
// 扫描器按 agent 聚合时是独立主体（v1 关遥测防的是 pianist-dev-* 自指环，编排器名下无此环）。
let rt;
try {
	rt = buildRuntime({
		sheetText,
		supervisorCfg: { timeoutMs: TIMEOUT * 1000 },
		cwd: CWD,
		pollApprovals: false, // 单发跑批不挂审批上浮轮（壳不在场也不告警噪音）
		// piBin 缺省 → 驱动器读 ORCH_PI_BIN env（测试 stub 位）→ 默认 bundle；
		// progressDir/telemetryDir/sessionsDir 缺省走 env 注入（PIANIST_*/ORCH_*），生产路径兜底。
	});
} catch (e) {
	console.error(`[retropad] 编排器组装失败（任务书/配置形状）：${e.message}`);
	fs.rmSync(workDir, { recursive: true, force: true });
	failFinish(`编排器组装失败：${e.message}`);
}

let rec;
try {
	rec = rt.launchMinion({ taskId, role: "复盘分身" }); // minionId 缺省 = ${taskId}-复盘分身-1
} catch (e) {
	console.error(`[retropad] 复盘分身拉起失败：${e.message}`);
	fs.rmSync(workDir, { recursive: true, force: true });
	failFinish(`分身拉起失败：${e.message}`);
}
const minionId = rec.minionId;

console.log(`[retropad] 拉起复盘分身：${hotspots.length} 重复热点 + ${errorHotspots.length} 错误热点，minionId=${minionId} pid=${rec.pid} timeout=${TIMEOUT}s${DRY ? "，dry-run" : ""}`);

// 心跳双源 + 双时钟 + 看门：一个 interval 打包 poll→tick→sweep（生产常驻 tick 同款序，不挂审批轮）。
// beat 来源记账：交货时出「心跳源=telemetry+session」——双源是否真喂，账面可见不靠自觉。
const beatSources = new Set();
const loop = setInterval(() => {
	for (const b of rt.pollBeats()) beatSources.add(b.source);
	rt.tick(Date.now());
	rt.sweep();
}, 250);

let exit;
try {
	exit = await rt.driver.rows.get(minionId).closed; // 退场结算（含被双时钟收尾的信号死）
} finally {
	clearInterval(loop);
	for (const b of rt.pollBeats()) beatSources.add(b.source); // 尾拍补喂（closed 后最后一轮）
	rt.tick(Date.now()); // 信号死收尾链（pendingKill→finalize→讣告）要再推一拍
	rt.stop();
}

const ledgerRow = rt.ledger.get(minionId);
console.log(
	`[retropad] 台账：${minionId} 状态=${ledgerRow?.status ?? "无行"} 心跳=${ledgerRow?.lastHeartbeat ?? "无"}` +
	` 心跳源=${beatSources.size ? [...beatSources].join("+") : "无"} 最后事件=${ledgerRow?.lastEventKind ?? "无"}`,
);

const finish = (code) => {
	fs.rmSync(workDir, { recursive: true, force: true }); // 指针文件跑完即清（prompt 已消费）
	process.exit(code);
};

// 死亡落账（v3 三修③，t16-fix）：非法收工也写 state（verdict=failed+failStreak）——due 源不空转；
// 下一场读它批次自适应减半，连续两死出声报修（消费面在批次上限段）。只在触发器已发车的跑里落
// （没发车的早退不是复盘失败，不落账）；写不进 state 也照退 exit 3——落账是账不是门。
const failFinish = (detail) => {
	let streak = 1;
	try {
		const prev = readRetroState(path.resolve(CWD, STATE));
		streak = (prev.raw?.verdict === "failed" ? Math.max(1, Number(prev.raw.failStreak) || 1) : 0) + 1;
		writeRetroState(path.resolve(CWD, STATE), Date.now(), {
			taskId, reason: trig.reason, verdict: "failed", failStreak: streak,
			detail: String(detail).slice(0, 200),
		});
	} catch (e) {
		console.error(`[retropad] 失败落账写不进（state=${STATE}）：${e.message}`);
	}
	console.error(`[retropad] 失败落账：verdict=failed failStreak=${streak}（${detail}）——下一场批次自适应减半`);
	if (streak >= 2) console.error(`[retropad] 报修：连续 ${streak} 场复盘死亡——retropad/复盘分身管线需要人看（批次减半救不了环境病，冷却再战也是空转）`);
	finish(3);
};

// ---------------------------------------------------------------------------
// 收尾：从收件箱取裁决（交货单 manifest.tail；替代 v1 的 stdout 尾部 JSON 提取）
// ---------------------------------------------------------------------------
const item = rt.inbox.items.find((i) => i.payload?.minionId === minionId) ?? null;
if (!item) {
	console.error(`[retropad] 分身退场但收件箱无收尾件（exit code=${exit?.code} signal=${exit?.signal}）——编排器收尾链断，当失败收`);
	failFinish("收件箱无收尾件（编排器收尾链断）");
}
if (item.kind === "讣告") {
	console.error(`[retropad] 分身死亡：${item.payload.cause ?? "?"}——${item.payload.causeDetail ?? ""}`);
	failFinish(`分身死亡：${item.payload.cause ?? "?"}`);
}
if (item.kind === "通知") {
	console.error(`[retropad] 分身上浮：${item.payload.reason ?? "?"}——${item.payload.detail ?? ""}`);
	failFinish(`分身上浮：${item.payload.reason ?? "?"}`);
}
if (item.kind !== "交货单") {
	console.error(`[retropad] 收件箱来了不认识的送达物：${item.kind}`);
	failFinish(`不认识的送达物：${item.kind}`);
}

const manifest = item.payload.manifest ?? {};
console.log(`[retropad] 交货单：进收件箱（seq=${item.seq}，exitCode=${manifest.exitCode}，tail ${manifest.tail?.length ?? 0} 字）`);

// 从交货单 tail 提取最后一个 JSON 对象：从最后的 { 逐个回退试后缀解析
// （贪婪正则会把「解释文字里的 JSON + 裁决 JSON」并成一个块，解析必炸）。
// 先剥掉收工协议行：v1 时代 JSON 是 stdout 最后一行，编排器收工协议要求末行 DONE——
// JSON 之后多了协议行，不剥则后缀解析在每个 { 位置都撞上尾暗DONE。
let cleaned = String(manifest.tail ?? "").replace(/```(?:json)?/g, "");
cleaned = cleaned.replace(/(?:^|\n)\s*DONE\b[\s\S]*$/, "").trimEnd();
let verdict = null;
for (let i = cleaned.lastIndexOf("{"); i >= 0; i = cleaned.lastIndexOf("{", i - 1)) {
	try { verdict = JSON.parse(cleaned.slice(i)); break; } catch { /* 回退下一个 { */ }
}
if (!verdict || typeof verdict.verdict !== "string") {
	console.error(`[retropad] 分身输出无合法 JSON 裁决——交货单 tail 末 800 字：\n${String(manifest.tail ?? "").slice(-800)}`);
	failFinish("分身输出无合法 JSON 裁决");
}

console.log(`[retropad] 分身裁决: ${verdict.verdict}${verdict.note ? ` —— ${verdict.note}` : ""}`);
// （洞9 v1 的 stderr 杂音记账在编排器路径下退位：stdout/stderr 已合流进交货单 tail 与讣告三源，不再正则猜杂音）
// 洞2（collaborator A #708 裁决「占位」）：健康问答案先落账——n/a=经图无本分身产出资产（占位期常态），
// ok=有产出且都活着，issues:*=有产出且有坏账。占位期不设断言，第一本转正后答案开始有信息量。
console.log(`[retropad] 健康问: ${verdict.health ?? "(未填，占位期容忍)"}`);

// ---------------------------------------------------------------------------
// infra 工单出口（v2-2.1）：严格预算花在去重键上——title 必须非空字符串（形状坏=exit 3，
// 与 candidates 空列表同档）；detail/evidence 缺省容空、非字符串强转（次要字段不配枪毙一次复盘）。
// ---------------------------------------------------------------------------
const ticketsIn = verdict.tickets === undefined ? null : verdict.tickets;
if (ticketsIn !== null && !Array.isArray(ticketsIn)) {
	console.error(`[retropad] 裁决 tickets 字段形状坏（要数组，got ${typeof ticketsIn}）——当失败收：工单不落 tickets 账，state 落 failed 账`);
	failFinish("裁决 tickets 字段形状坏");
}
for (const t of ticketsIn ?? []) {
	if (!t || typeof t !== "object" || typeof t.title !== "string" || !t.title.trim()) {
		console.error(`[retropad] 裁决 ticket 形状坏（要 {title,detail,evidence}，title 非空字符串）——当失败收：工单不落 tickets 账，state 落 failed 账`);
		failFinish("裁决 ticket 形状坏");
	}
}
let ticketsFiled = 0;
if (DRY) {
	if (ticketsIn && ticketsIn.length > 0) {
		console.log(`[retropad] dry-run：${ticketsIn.length} 张工单不落 tickets.jsonl，内容如下`);
		for (const t of ticketsIn) console.log(JSON.stringify(t, null, 2));
	}
} else {
	const ticketsPath = path.resolve(CWD, TICKETS);
	const filedTitles = new Set();
	if (fs.existsSync(ticketsPath)) {
		for (const line of fs.readFileSync(ticketsPath, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try { filedTitles.add(JSON.parse(line).title); } catch { /* 坏行不拒收新单（append-only 日志） */ }
		}
	}
	for (const t of ticketsIn ?? []) {
		const title = t.title.trim();
		if (filedTitles.has(title)) {
			console.log(`[retropad] 工单已在本（title=${title}）——去重跳过`);
			continue;
		}
		fs.mkdirSync(path.dirname(ticketsPath), { recursive: true });
		fs.appendFileSync(ticketsPath, JSON.stringify({
			v: 1, ts: new Date().toISOString(), taskId, title,
			detail: String(t.detail ?? ""), evidence: String(t.evidence ?? ""), status: "open",
		}) + "\n");
		filedTitles.add(title);
		ticketsFiled += 1;
		console.log(`[retropad] infra 工单落账：${title}${t.detail ? ` —— ${String(t.detail).slice(0, 120)}` : ""}`);
	}
	if (ticketsIn && ticketsIn.length > 0) {
		console.log(`[retropad] 工单合计：新落 ${ticketsFiled} / 报来 ${ticketsIn.length}（同名去重 ${ticketsIn.length - ticketsFiled}）`);
	}
}

if (verdict.verdict === "nothing") {
	console.log(`[retropad] 本场没有值得记的——合法输出，收工`);
	writeRetroState(path.resolve(CWD, STATE), Date.now(), { taskId, reason: trig.reason, verdict: "nothing", tickets: ticketsFiled });
	finish(0);
}

const cands = Array.isArray(verdict.candidates) ? verdict.candidates : [];
if (cands.length === 0) {
	console.error(`[retropad] verdict=candidates 但列表空——形状坏，当 nothing 收但不投`);
	failFinish("verdict=candidates 但列表空");
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

let failed = false;
if (DRY) {
	console.log(`[retropad] dry-run：${cands.length} 个 candidate 不投，内容如下`);
	for (const c of cands) console.log(JSON.stringify(c, null, 2));
} else {
	for (const c of cands) {
		try {
			const r = await submit(c);
			const ok = r.status === 200;
			console.log(`  ${ok ? "✓" : "✗"} ${c.name} → Grimoire HTTP ${r.status}${ok ? "" : `: ${r.body.slice(0, 200)}`}`);
			if (!ok && r.status !== 409) failed = true; // 409=同名已提交过，幂等处理不算失败
		} catch (e) {
			console.error(`  ✗ ${c.name} → 提交异常: ${e.message}`);
			failed = true;
		}
	}
	if (!failed) console.log(`[retropad] 收工：${cands.length} 个 candidate 已投Grimoire（draft）——产房不是户口，转正走巡山`);
}
// 状态文件：合法收工在这里记；失败路径已由 failFinish 落账（v3 三修③：verdict=failed 也在账上，
// due 源不空转——下一场读 verdict=failed 批次自适应减半，不再空转冷却-再死循环）
if (!failed) writeRetroState(path.resolve(CWD, STATE), Date.now(), { taskId, reason: trig.reason, verdict: verdict.verdict, candidates: cands.length, tickets: ticketsFiled });
finish(failed ? 0 : 0);
