#!/usr/bin/env node
// conductor — §三抽卡制地基（2026-09-24）。空闲>30min→等概率抽part→拉起pi session。
// 裁定（collab-issue）：独立进程不碰壳；对event-queue只读不写；只做§九环境事件消费层。
// 预算：当日(JST)遥测cost.total之和≥上限→当天硬停。
// 用法：常驻 / --once / --once --dry-run（--dry 同义）/ --status
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { envOrVault } from "../credentials/env-source.mjs";
import { evaluateRetroTrigger, readRetroState, DEFAULT_RETRO_INTERVAL_MS } from "./orchestrator/retro-trigger.mjs";
import { emitEvent } from "./orchestrator/emit.mjs";
import { nowJstDay } from "./orchestrator/day-clock.mjs";
import { parseTtlMode, sweepAccountLine } from "./inbox-ttl.mjs";
import { evaluateSchedule, readSchedule, writeSchedule, readActiveHoursFile } from "./schedule/index.mjs";

const args = process.argv.slice(2);
function arg(name, dflt) {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return dflt;
	const v = args[i + 1];
	return v === undefined || v.startsWith("--") ? dflt : v;
}
const ONCE = args.includes("--once");
const DRY = args.includes("--dry-run") || args.includes("--dry"); // --dry 短同义入口
const STATUS = args.includes("--status");
const SELFCHECK = args.includes("--self-check");
const CWD = path.resolve(import.meta.dirname, "..");
const SHELL_URL = process.env.PIANIST_SHELL_URL ?? "http://127.0.0.1:8770";
const IDLE_MS = Number(arg("idle-min", "30")) * 60_000;
const TICK_MS = Number(arg("tick-sec", "60")) * 1000;
const DAILY_BUDGET = Number(process.env.CONDUCTOR_DAILY_BUDGET ?? arg("daily-budget", "2"));

// hotspot 心跳缝（2026-10-01 wander 认领 09-30 seed「发现闭环没有心跳」）：latest.json 只在
// 有人记得时才重扫——停过五天。心跳=发现闭环自己的呼吸，挂在 conductor 常驻循环上：
// 报告陈旧（默认 20h 窗）即扫。不进 part 池、不记 draws/launches、不进预算账（纯机械零 LLM）。
// 为什么是 conductor 不是独立 systemd timer：本宅伤口大户是部署缝（09-28 引号/09-29 表名/
// 09-30 SVPS_SSH 三连），第三对 unit+timer 平添安装/拆除/env 三处新缝；conductor 已常驻、
// node 版本钉过、rearm 补刀件现成——心跳随它活。conductor 死 ⇔ 全宅黑（无新遥测），心跳的
// 价值域与之同变，独立 timer 在死宅里扫旧账无意义。验收形状（seed 原文）：latest.json
// 生成时间永不见 25h+。失败 5min 冷却重试：报警声保留，不刷屏也不静默（自愈式覆盖写）。
const HOTSPOT_STALE_H_RAW = Number(process.env.CONDUCTOR_HOTSPOT_STALE_H ?? 20);
const HOTSPOT_STALE_MS = (Number.isFinite(HOTSPOT_STALE_H_RAW) ? Math.max(0, HOTSPOT_STALE_H_RAW) : 20) * 3600_000; // 0h=测试强制陈旧；负数/垃圾回默认 20h
const HOTSPOT_OUT = process.env.CONDUCTOR_HOTSPOT_OUT ?? path.join(CWD, "data", "hotspots", "latest.json");
const HOTSPOT_DIR = process.env.CONDUCTOR_HOTSPOT_DIR ?? process.env.PIANIST_TELEMETRY_DIR ?? path.join(CWD, "data", "telemetry");
const HOTSPOT_RETRY_MS = 5 * 60_000;

// retro 触发心跳缝（2026-10-11 v2-2 接线单）：retro-trigger 三源触发器造好了没人调，错误热点
// 躺在 latest.json 里没人扣扳机。本缝=消费方：每 tick 判一次「现在值不值得拉 retropad」——判定在
// conductor 侧做（判定行进 conductor journal，不用翻 retropad 日志），fire 时拉起 retropad
// （不带 --force：retropad 内部幂等复判一次，几秒间隔内热点数不变，双保险不是冗余）。
// 与 hotspot 心跳同款口径：纯机械零 LLM、不进 part 池、不记 draws/launches、不进预算账（复盘
// 分身的花销走 retropad/buildRuntime 自己的记账路线，conductor 不代管）。连环拉保护：fire 后
// state 记 last_retro_fire（对齐 last_hotspot_scan 形状），冷却窗（复用 DEFAULT_RETRO_INTERVAL_MS
// 语义）内不再 fire——成败同窗（失败也等窗过，不刷屏重试）。dry-run 只彩排不 spawn。
const RETRO_STATE_FILE = process.env.CONDUCTOR_RETRO_STATE ?? path.join(CWD, "data", "retro", "state.json"); // retropad 合法收工写的账（due 源读它）——conductor 只读不写
const RETROPAD_BIN = process.env.CONDUCTOR_RETROPAD_BIN ?? path.join(CWD, "src", "retropad.mjs"); // 测试/演练可换 stub（同 CONDUCTOR_PI_BIN 位）
const RETRO_COOLDOWN_MS = DEFAULT_RETRO_INTERVAL_MS; // 连环拉冷却窗：与抽检间隔同钟（6h）

// 更夫（F1，2026-10-18 f1-watchman 单，spec：docs/f1-watchman-spec-v0.1.md）：launch 死了之后
// 的机械判定——拉不拉、拉几次、什么时候停手转人类。纯判定在 src/watchman.mjs（零 IO 零
// LLM），本文件只做接线：①两处死亡分支挂判定（consumeSchedule 任务型 / tick 班次型）②开机
// 首 tick 补验尸（A 面无主行断电孤儿 + B 面 fired×launches 反查）③state.watchman 台账④hearth
// 报备客户端。拔插头纪律（验收 1）：watchman 模块缺失/抛错 → conductor 照跑——更夫死了
// 不打更，宅子照常开灯（与 hotspot/retro 心跳同款：骨头断了肉照长）。
const WATCHMAN_MAX_RAW = Number(process.env.CONDUCTOR_WATCHMAN_MAX ?? 3);
const WATCHMAN_MAX = Number.isFinite(WATCHMAN_MAX_RAW) && WATCHMAN_MAX_RAW >= 1 ? Math.floor(WATCHMAN_MAX_RAW) : 3; // 停拉上限（spec ⑥ 默认 3，env 可调——突变面：上限真在读不是写死）
const HEARTH_URL = () => process.env.HEARTH_URL ?? "http://172.26.176.1:7788"; // hearth报备地址（报备时才连，失败不拦）
// F3 存在感事件账（docs/f3-emit-hook-spec-v0.2.md）：更夫判定/停拉转人类各发一条心跳事件——
// 旁路（emitEvent 写失败自己吞，不拦判定不拦报备）。ORCH_EVENTS_DIR：事件目录注入位
//（缺省 emit.mjs 的 repo 相对 data/events）。
const EMIT_OPTS = () => (process.env.ORCH_EVENTS_DIR ? { eventsDir: process.env.ORCH_EVENTS_DIR } : {});
const WATCHMAN_AUTOPSY = { done: false }; // 进程级旗：开机首 tick 补验尸一次（重启=新进程=再验；盘上幂等位防重报）

// F2 收件箱按天清（docs/f2-inbox-ttl-spec-v0.2.1.md）：壳审批卡隔夜过期自动 deny（by=system-expired，
// 审批人侧可查终态）。env 逃生门 CONDUCTOR_INBOX_TTL=day|24h|tiered——默认 day=方案 A 正典
//（the user 10/18 拍板「与 Moonshake day file 同款」+ 10/19 窗口参数拍板 A）；24h/tiered 为 B/C 逃生门。
// 非法值常驻面 fail-fast（exit 1 + 出声，别静默跑歪钟）；--once/--status 彩排面不设卡（同正典自检口径）。
const INBOX_TTL_RAW = process.env.CONDUCTOR_INBOX_TTL;
const INBOX_TTL_MODE = parseTtlMode(INBOX_TTL_RAW); // null=非法；缺省/空 → "day"

function todayJST() {
	return nowJstDay(); // F2 钟屋收编：原末内联同式日钟改为 day-clock.mjs 单点（行为不变，只灭第二座钟）
}

const STATE_DIR = process.env.CONDUCTOR_STATE_DIR ?? path.join(CWD, "data", "conductor");
const STATE_FILE = path.join(STATE_DIR, "state.json");
function loadState() {
	try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { return { days: {}, launches: [] }; }
}
function saveState(st) {
	fs.mkdirSync(STATE_DIR, { recursive: true });
	fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 1));
}

// ---- 死亡最小通道（2026-09-29 用户采访「为死者发言」→ T7 落地）----
// 病灶（09-28 00:28 事故）：launch 行收工后才记——分身中途死（信号杀/预算闸/宿主停机）整行
// 蒸发，死掉的分身连「它启动过」都没留下（报告/遥测尾批/launch 记录三失之一）。修法=launch
// 先写后做（tick 内 spawn 前落 pending 行）+ 两个死法的死因入账：死法一在 launchPart 的
// close(signal)回填同行；死法二在本钩子。拍板：死亡状态落 launches 行内回填，不另起独立
// 日志文件——少一个文件少一条部署缝（与 hotspot 心跳不做第三对 systemd unit 同一哲学）；
// pi 侧不改（外部 runtime，非本仓地界）。
function markPendingLaunchesDown(st, signalName) {
	let n = 0;
	for (const l of st.launches ?? []) {
		if (l.exit === undefined && l.signal === undefined) { l.exit = null; l.signal = signalName; n += 1; }
	}
	return n;
}
// 死法二：conductor 自身被 SIGTERM（systemd stop/预算闸）——在途 pending 行补
// signal="parent-down"（父进程停机死）落盘后再退。saveState 是 writeFileSync 同步写，来得及。
// 从盘上重读再写：tick 手里的内存账可能还没落，但进程即退，以盘为准不丢已落的 pending 行。
function sigtermHandler() {
	try {
		const st = loadState();
		const n = markPendingLaunchesDown(st, "parent-down");
		if (n > 0) {
			saveState(st);
			console.log(`[conductor] SIGTERM——在途 launch ${n} 行补 signal=parent-down 入账（死也留名）后收工退出（systemd stop）`);
		} else {
			console.log("[conductor] SIGTERM——无在途 launch，收工退出（systemd stop）");
		}
	} catch (e) {
		console.warn(`[conductor] SIGTERM 补账失败（尽力退出）：${e?.message ?? e}`);
	}
	process.exit(0);
}

// 空闲检测：遥测目录所有文件里最新一条 message_end/tool_use 距 now > IDLE_MS
// 忙判测试开关：测试/演练时置 CONDUCTOR_IDLE_NOW=1 跳过遥测忙判（视为已空闲）
function idleMsOverride() {
	return process.env.CONDUCTOR_IDLE_NOW === "1";
}
function lastActivityMs() {
	const dir = process.env.PIANIST_TELEMETRY_DIR ?? path.join(CWD, "data", "telemetry");
	let latest = 0;
	let nFiles = 0;
	let files = [];
	try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return { latest: 0, nFiles: 0 }; }
	for (const f of files) {
		nFiles += 1;
		const lines = fs.readFileSync(path.join(dir, f), "utf8").trim().split(/\r?\n/);
		for (let i = lines.length - 1; i >= 0; i--) {
			let ev; try { ev = JSON.parse(lines[i]); } catch { continue; }
			if (ev?.kind !== "message_end" && ev?.kind !== "tool_use") continue;
			const t = Date.parse(ev.ts);
			if (Number.isFinite(t)) { latest = Math.max(latest, t); break; }
		}
	}
	return { latest, nFiles };
}

// part 池可用 CONDUCTOR_PARTS 覆盖（测试/演练用），逗号分隔 id，过滤后仍等概率
const PARTS_ALL = [
	{
		id: "wander",
		desc: "Part3 漫游（纯自主无喂入）",
		prompt: [
			"你是 Emergence Pianist 的漫游分身（wander part）。这是一场纯自主漫游 session：没有任务、没有热点报告、没有期望产出。",
			"你可以做的事：读这个仓库里的遥测和热点报告，看最近的自己们留下什么痕迹；顺着痕迹走（某段重复劳动、某个没走完的 loop、某个反复出现的错误形状）；也可以什么都不查，只写你想写的。",
			"纪律：",
			"1. 单 session 预算内闭环本轮——结尾给一段 200 字以内的收尾笔记（今天走到了哪、值得留下的一句）。",
			"2. 播种纪律：如本轮值得开新线索，收尾下种不超过 1 条 thread，初始 w 封顶 0.5 且标 source=seed。",
			"3. 不读、不引用、不猜测任何用户私人内容——你的视野只有这个仓库。",
			"4. 落码未上膛（换防正典，2026-10-11 第三班种子，本班认领转正）：若本轮改了 conductor 启动期加载的码（src/conductor.mjs、src/orchestrator/*），而本 session 就活在 conductor 的 cgroup 里——restart=自杀，别裸跑别裸 restart。正典：systemd-run --unit=pianist-conductor-rearm --collect /bin/sh deploy/rearm-conductor.sh 挂清道夫等你退役后补刀（exact 姿势与判忙纪律以该脚本头注为准）。",
		].join("\n"),
	},
	{
		id: "env-event",
		desc: "§九环境事件消费（event-queue 慢通道）",
		// 牌面由 conductor 拉起前注入（events 参数）；队列不可达时降级为空牌面确认跑。
		// 降级≠空队列，文案分叉（2026-10-01 wander，六场空牌病历）：09-25~09-30 六场空牌各自
		// 猜一个不存在的桥动作名（event-queue.poll/status/probe/peek_env_event_queue/grimoire_event，
		// 每场措辞各异——同型异辞，文本收敛门对它全瞎）去重探 conductor 已探过的队列。修因在
		// prompt 没把「不可达」和「空」分开，也没明说「探不到的缝不在你座位上」。
		prompt: (events) => [
			"你是 Emergence Pianist 的环境事件分身（env-event part）。慢通道轮到你了：event-queue 里有实时环境唤起在排队，你的任务是消费这一批。",
			"",
			"本轮牌面（conductor 预取，含 thread_id/cosine/信号摘录）：",
			events && events.length
				? events.map((e) => `- #${e.thread_id} cos=${e.cosine} [${e.signal_source}] ${e.signal_text.slice(0, 80).replace(/\n/g, " ")} (${e.logged_at})`).join("\n")
				: events === null
					? "（队列不可达——conductor 预取时已经探过一次并失败：修因在部署侧（远端/表名），不在你的座位上，你换任何工具或动作名再探只会得到同一个结果。本轮降级为空牌面确认跑：写 100 字以内的收尾笔记即可，不要去探队列。）"
					: "（队列可达且无新事件——真无事可消费，写 100 字以内的收尾笔记即可。）",
			"",
			"逐条判断：这条环境信号对pianist们最近的活动有没有实质关联——没有就明说「这条不接」；有关联的，把判断写进收尾笔记（200字以内）。",
			"纪律：只消费不动账——event-queue 你只读不写；牌面由 conductor 预取，你不自己去拉队列、也不猜 pianist_bridge 的动作名（动作面在壳上不在你的牌上，猜不中——六场空牌各猜一个名字全败的病历见上）；单 session 预算内闭环。",
		].join("\n"),
	},
	{
		id: "todo-review",
		desc: "§八 session spoor 第一铲：to do 三件套过滤（细则已转正 2026-09-25 三题裁定）",
		// 牌面由 conductor 拉起前注入（board 参数）；workbench 读不到时降级为空牌面确认跑
		prompt: (board) => [
			"你是 Emergence Pianist 的待办对账分身（todo-review part）。这条产线是蓝图 §八 session spoor 的第一铲：家里各项目 STATUS.md 的「下一步」段攒了债，你来按准入三件套过一遍筛。",
			"",
			"本轮牌面（conductor 预取，workbench 各项目 STATUS.md「下一步」段原文）：",
			board && board.lines && board.lines.length
				? board.lines.join("\n")
				: board === null
					? "（workbench 不可读——本轮降级为空牌面确认跑，写 100 字以内的收尾笔记即可。拉不到清单不等于清单为空。）"
					: "（各项目「下一步」段均空——真无债可审，写 100 字以内的收尾笔记即可。）",
			"",
			"准入三件套（§八原文 + 2026-09-25 细则转正，三题裁定已进）：",
			"1. 对话出处——能指回一段真实协商（房间+楼层号，或 session id）。出处判据是「有人接过这一单」不是「有人写过这一行」；光在 STATUS 里躺着的算「想要」不算「协商过」。最低门槛（裁定①）：the user 明确批过算，AI 侧自己认领也算——但认领达成共识时须通知 the user（通知义务），出处须指向她可见的楼层。",
			"2. 验收判据——写成可检查的：谁跑、跑什么、什么输出算过。反例「优化性能」；正例「node20 上 npm install 报 engines 人话（实跑验证）」。",
			"3. 到期预算——两半：到期日 + 烧钱上限。超任一半不是静默滚存，是出声报死：「此项 X 日到期 / 超预算 Y，弃或续请拍板」。报死后谁拍板（裁定②）：花钱的事 the user 拍，时间的事当天值班者拍。",
			"",
			"逐条裁：三件套齐的标「够格」；缺 X 的如实标「跳过：缺X」——不装筛完，不够格也不删（回炉等补齐）。条目格式（T<id> [归属]…｜出处｜判据）与三件套是两回事：格式齐是协议 v0.9 的形状，三件套齐才是协商过。",
			"旧格式行 conductor 已在读入侧机械迁移成 v0.9 形状（牌面标「（迁移 T<n>）」，撞号改名的再标「迁移改名」）——虚拟迁移只转管线内存里的牌面，STATUS.md 原文不写、仍待迁移（真迁移回写是活人的活）；迁移管形状不造内容，缺的归属/出处/判据栏空着，照常按三件套裁（缺什么如实标，回炉等补齐）。",
			"标「（非条目·散文段）」的行不转不裁——散文不是条目，转了是伪造结构；收尾笔记单列散文几条即可。",
			"收尾笔记 200 字以内：够格几条、跳过几条（各缺什么）、迁移几条、散文几条。",
			"纪律：只读不写——STATUS.md、journal 你都不碰；单 session 预算内闭环。",
		].join("\n"),
	},
	{
		id: "spoor-session",
		desc: "§八 session spoor 真身：三件套准入+分身裁决",
		// 牌面由 conductor 拉起前注入（board 参数+机判结果）；workbench 读不到时降级为空牌面确认跑
		// 三件套机判占在 conductor（只判形状），值不值得动占在 prompt（分身裁决）——洞2刀法同款
		prompt: (board, judged) => [
			"你是 Emergence Pianist 的 session spoor 分身（spoor-session part）。这条产线消费「漂着的债」：todo-review 管筛形状，你管动真章——三件套机判已由 conductor 做完，你的裁决对象是每条够格 to do 的「现在值不值得动」。",
			"",
			"本轮牌面（conductor 预取+三件套机判，workbench 各项目 STATUS.md「下一步」段）：",
			board === null
				? "（workbench 不可读——本轮降级为空牌面确认跑，写 100 字以内的收尾笔记即可。拉不到牌面不等于没有债。）"
				: judged?.groups?.length
					? judged.groups.map((g) => [
						`[${g.project}]${g.confirmed ? "　" + g.confirmed : ""}`,
						...g.rows.map((r) => `- ${r.verdict === "够格" ? "✔" : r.verdict.startsWith("跳过") ? "✘" : "？"} ${r.head}${r.mark ? `（${r.mark}）` : ""} —— 机判：${r.verdict}`),
					].join("\n")).join("\n")
					: "（各项目「下一步」段均空——真无债可动，写 100 字以内的收尾笔记即可。）",
			"",
			"三件套机判口径（the user 2026-09-25 准入细则拍板）：①对话出处——出处栏非空且可指回（房间#楼层 或 session 引用）；②验收判据——非纯口号的可检查形状（谁跑/跑什么/什么算过）；③到期预算——有日期形状（YYYY-MM-DD 或 N天内）。缺任何一件=跳过：缺X，如实报不装消费完，也不替 the user 补栏。",
			"",
			"牌面标注（T8 读入侧虚拟迁移）：带「（迁移 T<n>）」的行是 conductor 从旧格式机械转的 v0.9 形状——STATUS.md 原文未动（真迁移回写是活人的活），管形状不造内容，缺的栏空着照判；「迁移改名」= 剥装饰后撞段内既有号、加撇保唯一；带「（非条目·散文段）」的行不转不判——散文不是条目，转了是伪造结构。",
			"",
			"你的裁决：",
			"1. 逐条够格 to do 判断「现在值不值得动」——值得的给一句话理由，不值得的也如实说。",
			"2. AI 侧认领开工的：认领即算协商过（拍板1），但达成共识时必须通知 the user——认领共识经壳的 /notify 知道线出声（认领达成共识时，调用 notify_claim 报备 the user——summary 一句话+牌号；收尾笔记仍要写）。",
			"3. 超预算报死（拍板2）：花钱的事 the user 拍板，时间的事当天值班者拍板——你不替谁拍，只出声。",
			"",
			"收尾笔记（200字内）必须含：够格 N 条/跳过 M 条（各缺什么）/迁移 J 条/散文 D 条；够格里值得动的 K 条及一句话理由；首轮跑全量时附够格名单（T<id> 串即可）供 the user 追认（拍板3：第一轮跑完给全量名单）。",
			"纪律：只读不动账——STATUS.md 不写回、journal 不碰；跳过条不回炉不删；单 session 预算内闭环。",
		].join("\n"),
	},
	{
		id: "tideline-threads",
		desc: "记忆线索探索（tideline threads）",
		// 牌面由 conductor 拉起前注入（threads 参数，dualcard 交付二 2026-10-12）：本地 tideline 库
		// threads 表按 weight 降序前 10。库/表还没长出来（null）≠ 没有 open 线索（[]）——文案分叉
		// 照 env-event 空/降级先例（2026-10-01 六场空牌病历：不分会把「探不到」喂成「猜动作名」）。
		prompt: (threads) => [
			"你是 Emergence Pianist 的记忆线索分身（tideline-threads part）。tideline 的 threads 表是家里漂着的记忆线索：每条是一个没走完的头绪（weight=值得回头看的热度，unresolved=未解度）。你的任务是挑动其中值得现在动的，把探索结果留下。",
			"",
			"本轮牌面（conductor 预取，weight 降序前 10，含 id/权重/未解度/状态/内容摘要）：",
			threads && threads.length
				? threads.map((t) => `- #${t.id} w=${t.weight} 未解=${t.unresolved} [${t.status}] ${String(t.content).slice(0, 80).replace(/\n/g, " ")}`).join("\n")
				: threads === null
					? "（tideline 库还没长出来——conductor 预取时本地库/threads 表读不到：不是没有线索，是家当还没归位。本轮降级为空牌面确认跑：写 100 字以内的收尾笔记即可，不要自己去翻 tideline 的库或猜库的路径。）"
					: "（threads 表可达且当前没有 open 线索——真无线可探，写 100 字以内的收尾笔记即可。）",
			"",
			"逐条判断：这条线索值不值得现在动——不值得的明说「这条不接」；值得动的顺着 content 的头绪在本仓内探索（读代码/读遥测/读 journal），把走到的判断写进收尾笔记。",
			"纪律：只读不写——threads 表你只读不写（线索的增删改是 tideline 自己的界，动它是越界）；单 session 预算内闭环本轮；收尾笔记 200 字以内。",
			"开新线走播种纪律（同 wander part）：如本轮值得开新线索，收尾下种不超过 1 条 thread，初始 w 封顶 0.5 且标 source=seed——开新线是播种不是移山。",
		].join("\n"),
	},
];

const PARTS = process.env.CONDUCTOR_PARTS
	? PARTS_ALL.filter((p) => process.env.CONDUCTOR_PARTS.split(",").map((s) => s.trim()).includes(p.id))
	: PARTS_ALL;

// 预算：遥测 message_end 的 cost.total 之和，日历日按 JST 从事件 ts 换算
// （不用文件名过滤——文件名按 UTC 日轮转，JST 晚间的账会躺在前一天的文件里）
function dailySpendYen() {
	const dir = process.env.PIANIST_TELEMETRY_DIR ?? path.join(CWD, "data", "telemetry");
	const today = todayJST();
	let spend = 0;
	let n = 0;
	let files = [];
	try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); } catch { return { spend: 0, n: 0 }; }
	for (const f of files) {
		for (const line of fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/)) {
			let ev; try { ev = JSON.parse(line); } catch { continue; }
			if (ev?.kind !== "message_end" || !ev.data?.usage) continue;
			const jstDay = new Date(Date.parse(ev.ts) + 9 * 3600_000).toISOString().slice(0, 10);
			if (jstDay !== today) continue;
			n += 1;
			spend += ev.data.usage.cost?.total ?? 0;
		}
	}
	return { spend, n };
}

function drawPart(pool = PARTS) {
	return pool[Math.floor(Math.random() * pool.length)];
}

// ---- 正典自检（seed①，2026-09-26 wander 认领）----
// §1 事故形状：残骸 unit disable 后仍运行时存活、异名同源 unit 重启后双跑——disable 只管
// 重启不管运行时，此钉补运行时那半：常驻启动时验明正身，所属 unit 必须是 enabled 的正典。
// 不满足→出声退出 exit 1（Restart=on-failure 会每 30s 拉一次——journal 里的重复报警声就是
// 报警器本身，直到有人 disable/拆除残骸或跑 install-conductor.sh 正典化）。
// 例外与免检：非 systemd 托管（手动/dev 跑）免检；systemd-run 的 .scope 形状免检（v1 钉
// 不覆盖）；systemctl 不在（证据不足）放行——只凭实证拒绝，不凭缺席挡门。
// CONDUCTOR_SKIP_UNIT_CHECK=1：显式豁免（起草例外用，得在 unit env 里写明）。CONDUCTOR_SYSTEMCTL：
// 测试/演练换 stub（与 install-conductor.sh 同名覆写变量）。
const CANONICAL_UNIT = "pianist-conductor.service";
function ownUnitName(cgroupFile = "/proc/self/cgroup") {
	try {
		const cg = fs.readFileSync(cgroupFile, "utf8");
		const m = cg.match(/\/([A-Za-z0-9@:_.\-]+\.service)(?:\/|\s|$)/m);
		return m ? m[1] : null;
	} catch { return null; }
}
function unitSelfCheck(cgroupFile = "/proc/self/cgroup", systemctlCmd = process.env.CONDUCTOR_SYSTEMCTL ?? "systemctl") {
	const unit = ownUnitName(cgroupFile);
	if (!unit) return { unit: null, enabled: null, ok: true, reason: "非 systemd unit 托管（手动/dev 跑或 .scope 形状）——免检" };
	if (unit !== CANONICAL_UNIT)
		return { unit, enabled: null, ok: false, reason: `异名同源残骸（正典是 ${CANONICAL_UNIT}；disable 只管重启，运行时这半由本钉管）` };
	const r = spawnSync(systemctlCmd, ["is-enabled", CANONICAL_UNIT], { encoding: "utf8" });
	if (r.status === null)
		return { unit, enabled: null, ok: true, reason: `systemctl 不可用（${r.error?.code ?? "无退出码"}）——证据不足，放行` };
	if (r.status !== 0) {
		const st = String(r.stdout ?? "").trim() || `exit ${r.status}`;
		return { unit, enabled: st, ok: false, reason: `正典 unit 未 enable（is-enabled=${st}）——disable 后的运行时残留` };
	}
	return { unit, enabled: "enabled", ok: true, reason: "正典在位且 enabled" };
}

// env-event 远端表名（单源）：开源仓默认脱敏名 event-queue；私有部署真名经
// CONDUCTOR_EVENT_TABLE 注入（/etc/pianist/conductor.env）。饿死退避的「缝已改」判据
// 也读它——表名变了=部署侧动过缝，退避自动解除重探（2026-09-29 wander）。
function eventTable() {
	// 病名出声（2026-10-05 05:20 wander 补刀验尸）：EnvironmentFile 不剥行内注释——值里带 # 或
	// 空白 = 注释整段被吞进表名，SQL 必死 no such table，且 fetch 侧「写 CONDUCTOR_EVENT_TABLE」
	// 的修因行会误导（缝写了，只是写歪了）。值形状先验：把「写歪」和「没写」分开喊。
	const raw = process.env.CONDUCTOR_EVENT_TABLE;
	if (raw !== undefined && /[\s#]/.test(raw)) {
		console.warn(`[conductor] 病名 env 值带行内注释/空白：CONDUCTOR_EVENT_TABLE="${raw}"——EnvironmentFile 不剥行内 #，注释整段进表名。修法：注释挪独立行（# 开头）后重启本服务`);
	}
	return (raw ?? "event-queue").replace(/"/g, "");
}

// env-event 牌面预取：事件行 replay_day IS NULL 的实时行（未回放消费的）。失败出声降级为
// 空牌面（拉不到队列 ≠ 队列为空）——session 照拉，牌面标明降级原因。消费进度记在 conductor
// 自己的 state，不碰源库（INSERT-only 界约）。队列语义（collab-issue 钉a 裁定 ASC）：每轮吃
// 最老的 5 条，积压靠后续轮次续消——不会静默跳过任何一条；DESC+max 是快照语义，与「消费进度」
// 的承诺不符。
// 血源切换（2026-10-12 dualcard 交付一）：本地感官线已建（pianist-organ-runtime 器官→
// Moonshake eventlog→bridge→wake.db，表同形状 wake_log）——env-event 改本地优先。
// CONDUCTOR_EVENT_SOURCE 取 local / remote / local,remote（默认 local,remote=本地优先：
// 本地 ≥1 行直接用本地行；本地空或失败回落 remote）。本地/远端是两套行号空间→两个游标
//（state.last_env_event_local_id 管本地行、last_env_event_id 照旧管远端行——串门会跳行/重吃）。
// 降级纪律照旧：两条被咨询的源都拉不到才 null（拉不到≠空）；任一源健康且零行→[] 真空
//（以活着的源为准，死源已在它那层出声——本地优先世界里 remote 只是回落，它的死不该把
// 健康本地源的真空结论拖成降级，反之亦然）。
// 回落不是失败：本地死顶给 remote 不算病，退避账/病名出声（remote 侧 no such table）一概不动。
function eventSourceMode() {
	const raw = (process.env.CONDUCTOR_EVENT_SOURCE ?? "").trim();
	if (!raw) return { local: true, remote: true };
	const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
	const wantLocal = parts.includes("local");
	const wantRemote = parts.includes("remote");
	if (!wantLocal && !wantRemote) {
		console.warn(`[conductor] CONDUCTOR_EVENT_SOURCE="${raw}" 不认——回默认 local,remote（本地优先）`);
		return { local: true, remote: true };
	}
	return { local: wantLocal, remote: wantRemote };
}
// 行形状归一：本地 sqlite3 -json 与远端 ssh sqlite3 -json 同列，共用一个 mapper
function mapEventRow(r) {
	return {
		id: Number(r.id), thread_id: Number(r.thread_id), cosine: r.cosine,
		signal_text: String(r.signal_text ?? ""), signal_source: r.signal_source, logged_at: r.logged_at,
	};
}
// 本地源直读（dualcard 交付一）：不经 ssh——少一层引号嵌套地狱（远端那条缝见 fetchEnvEventsRemote
// 头注），表名带横杠也无需双层转义。失败=null 出声降级；no such table 另出人话：本地感官线真
// 表名是 wake_log，CONDUCTOR_EVENT_TABLE 与本地库对不上时指名缝在表名（与远端病名分开喊，修因不串门）。
function fetchEnvEventsLocal(lastLocalId) {
	const DB = process.env.CONDUCTOR_LOCAL_EVENT_DB ?? "/root/pianist-organ-runtime/wake.db";
	const TABLE = eventTable();
	const q = `SELECT id, thread_id, cosine, signal_text, signal_source, logged_at FROM "${TABLE}" WHERE replay_day IS NULL AND id > ${Number(lastLocalId) || 0} ORDER BY id ASC LIMIT 5`;
	const r = spawnSync("sqlite3", ["-json", DB, q], { encoding: "utf8", timeout: 20_000 });
	if (r.error || r.status !== 0) {
		const msg = `${r.stderr ?? ""}`.trim() || (r.error ? r.error.message : `exit ${r.status}`);
		console.warn(`[conductor] env-event 本地源预取失败（${DB}）——${msg}`);
		if (/no such table/i.test(msg)) console.warn(`[conductor] 本地库无表 "${TABLE}"——本地感官线真表名 wake_log：CONDUCTOR_EVENT_TABLE 需与本地库一致（与远端部署缝分开修）`);
		return null;
	}
	const parsed = (r.stdout ?? "").trim() ? JSON.parse(r.stdout) : [];
	return (Array.isArray(parsed) ? parsed : []).map(mapEventRow);
}
// 远端源（旧路，行为不动）：ssh 拉 the-remote 的 event-queue。
async function fetchEnvEventsRemote(lastId) {
	const SSH = process.env.CONDUCTOR_SVPS_SSH ?? "the-remote";
	const SSH_BIN = process.env.CONDUCTOR_SSH_BIN ?? "ssh"; // 测试替身：复刻双层 shell 解析的 ssh stub
	const DB = process.env.CONDUCTOR_MEMORY_DB ?? "~/memory/mcp_memory.db"; // 测试指夹具库
	// 表名可配：开源仓默认 event-queue（脱敏名）；私有部署在 /etc/pianist/conductor.env 写
	// CONDUCTOR_EVENT_TABLE=event-queue 指回真表。引号包裹必须留——横杠表名裸写=SQL语法错
	//（508753a 的脱敏名替换曾伤到此处功能面，the author 9/26 复验 563a1c1 时补获）。
	const TABLE = eventTable();
	const q = `SELECT id, thread_id, cosine, signal_text, signal_source, logged_at FROM "${TABLE}" WHERE replay_day IS NULL AND id > ${Number(lastId) || 0} ORDER BY id ASC LIMIT 5`;
	// 引号嵌套坑（09-28 wander 验尸 00:14 预取红）：整条 SQL 包在远端命令的外层双引号里，经 ssh
	// 交远端 shell 再解析一次——q 里的 " 会被当成外层闭口吃掉，横杠表名剥引号=SQL语法错
	//（journal: near "-": syntax error）。私有部署真名若不带横杠则症状隐形——剥掉引号照样
	// 合法——f648274 的「空集干净」验证因此漏网。内层 " 一律转义成 \\"，双层解析后原样送达。
	const remote = `sqlite3 -json ${DB} "${q.replaceAll('"', '\\"')}"`;
	const { execFile } = await import("node:child_process");
	return new Promise((resolve) => {
		execFile(SSH_BIN, [SSH, remote], { timeout: 20_000 }, (err, stdout) => {
			if (err) {
				console.warn(`[conductor] env-event 队列预取失败——空牌面降级（拉不到不等于没有）: ${err.message}`);
				// 病名出声（2026-09-29 wander 验尸 09-28 深夜三连红）：引号钉死后 SQL 已活到 sqlite，
				// no such table = 远端库真名≠当前表名——修因在部署缝不在代码：env 写 CONDUCTOR_EVENT_TABLE。
				// execFile 的 err.message 自带 stderr 尾行（journal 里那行 Error: in prepare 就是它）。
				if (/no such table/i.test(`${err.message}\n${err.stderr ?? ""}`)) {
					console.warn(`[conductor] 病名 no such table：远端库无表 "${TABLE}"——私有部署在 /etc/pianist/conductor.env 写 CONDUCTOR_EVENT_TABLE=<真表名> 后重启本服务（开源仓默认脱敏名 event-queue）`);
				}
				resolve(null); // null=预取失败（降级）；[]=无新事件
			} else {
				const parsed = stdout.trim() ? JSON.parse(stdout) : [];
				resolve((Array.isArray(parsed) ? parsed : []).map(mapEventRow));
			}
		});
	});
}
// fetchEnvEvents 总口（dualcard 后的血源分发）：返回 {source:"local"|"remote", rows}|null——
// source 给消费端推对的游标（两套行号空间各自续消）。本地优先语义：本地 ≥1 行直接用；本地
// 空/失败回落 remote；两源都交不出行时，双双失败→null（拉不到≠空），否则至少一源健康报
// 零行→[]（真无事可消费——source 仅记来路，零行不推游标）。
async function fetchEnvEvents(lastId, lastLocalId) {
	const mode = eventSourceMode();
	if (mode.local && !mode.remote) {
		const rows = fetchEnvEventsLocal(lastLocalId);
		return rows === null ? null : { source: "local", rows };
	}
	if (mode.remote && !mode.local) {
		const rows = await fetchEnvEventsRemote(lastId);
		return rows === null ? null : { source: "remote", rows };
	}
	const localRows = fetchEnvEventsLocal(lastLocalId);
	if (localRows !== null && localRows.length >= 1) {
		console.log(`[conductor] env-event 本地源中选（${localRows.length} 条，wake.db 血源）——本地优先`);
		return { source: "local", rows: localRows };
	}
	console.log(`[conductor] env-event 本地源${localRows === null ? "失败" : "无新行"}——回落 remote`);
	const remoteRows = await fetchEnvEventsRemote(lastId);
	if (remoteRows !== null && remoteRows.length >= 1) return { source: "remote", rows: remoteRows };
	// 两源都交不出行：双双失败→null 降级；否则至少一源健康报零行→[] 真空（旧路 remote 空库
	// 真空语义在此形状下保持——本地死+remote 空也是真空，本地只是回落不足为凭）。
	if (localRows === null && remoteRows === null) return null;
	return { source: "remote", rows: [] };
}

// tideline-threads 牌面预取（2026-10-12 dualcard 交付二）：读本地 tideline 库（默认
// /root/pianist-tideline/data/mcp_memory.db）的 threads 表——记忆线索（没走完的头绪），
// weight 降序前 10 进牌面。库不存在/表不存在→null 降级（「库还没长出来」≠「没有 open 线索」
// ——文案分叉照 env-event 空/降级先例）；表在零行→[]（真无线）。LIMIT 10 钉死：一场线索探索
// 吃得下的是十根线头，不是全库。只读不写：threads 表的增删改是 tideline 自己的界（prompt
// 纪律段同款钉死）。
function fetchThreadsBoard(quiet = false) {
	const DB = process.env.CONDUCTOR_TIDELINE_DB ?? "/root/pianist-tideline/data/mcp_memory.db";
	const q = `SELECT id, content, status, importance, unresolved, weight FROM threads ORDER BY weight DESC LIMIT 10`;
	const r = spawnSync("sqlite3", ["-json", DB, q], { encoding: "utf8", timeout: 20_000 });
	if (r.error || r.status !== 0) {
		const msg = `${r.stderr ?? ""}`.trim() || (r.error ? r.error.message : `exit ${r.status}`);
		if (!quiet) console.warn(`[conductor] tideline-threads 牌面预取失败——空牌面降级（库还没长出来≠没有 open 线索）：${msg}`);
		return null;
	}
	const parsed = (r.stdout ?? "").trim() ? JSON.parse(r.stdout) : [];
	return (Array.isArray(parsed) ? parsed : []).map((t) => ({
		id: Number(t.id), content: String(t.content ?? ""), status: t.status,
		importance: t.importance, unresolved: t.unresolved, weight: t.weight,
	}));
}

// todo-review 牌面预取：本地 the-workbench workbench 各项目 STATUS.md 的「下一步」段。
// 三件套判断占在 prompt 不在逻辑（洞2刀法，collab-issue/#771 认的形状）——这里只供牌面：
// 抽条目原文+标是否条目格式（T<id> [归属] …｜出处｜判据：…），够不够格由 session 按提示词裁。
// 细则（the-remote:2026-09-25-spoor-session准入细则-草稿.md）2026-09-25 三题裁定转正：
// ①AI认领算协商过+通知义务 ②报死拍板=花钱the user/时间值班者 ③追认有效+第一轮全量名单给她。
// 判据文字已进 prompt，骨架未动——「只换判据不动骨架」照旧成立。
// spoor-session 同源吃 boards（按项目结构化条目+排序确认段头）；三件套机判在 judgeSpoorBoard。
// 读不到=降级 null（拉不到清单≠清单为空）；空段=[]=真无债可审。
// T8 牌面格式机械迁移位（2026-10-02）：读入侧虚拟迁移——旧格式行进管线自动转 v0.9 形状，
// 只转内存牌面，STATUS.md 原文一律不写（真迁移回写是活人的活，管线不越界）。考古确认三种旧形状：
// ①ID 变体（T6(新) [the author]…，10/01 实录曾因不合形状被静默吞掉）剥装饰取裸号，撞段内既有号加撇保唯一；
// ②裸 bullet 无 ID（⑤第二铲：…，9/26 前旧牌面）机械发号 max(段内最大号,100)+1（100 内是活人手写号段）；
// ③内联散文体（tideline 9/24 真身）不转——散文不是条目，转了是伪造结构，单列非条目（散文段）。
// 栏位补齐纪律：管形状不造内容——缺归属/出处/判据就空着，让三件套机判如实报「跳过：缺X」回炉等补齐。
function fetchTodoBoard(partId = "todo-review", quiet = false) {
	const root = process.env.CONDUCTOR_STIGMERGY_ROOT ?? path.resolve(CWD, "..", "Stigmergy");
	const wb = path.join(root, "workbench");
	const lines = [];
	const boards = []; // spoor-session 用：按项目分组的条目 + 排序确认段头
	let projects = 0;
	try {
		const dirs = fs.readdirSync(wb, { withFileTypes: true })
			.filter((d) => d.isDirectory()).map((d) => d.name).sort();
		for (const dir of dirs) {
			let text;
			try { text = fs.readFileSync(path.join(wb, dir, "STATUS.md"), "utf8"); } catch { continue; }
			projects += 1;
			const m = text.match(/^##\s*下一步\s*$/m);
			if (!m) continue;
			const after = text.slice(m.index + m[0].length);
			const nextH2 = after.match(/^##\s/m);
			const section = (nextH2 ? after.slice(0, nextH2.index) : after).trim();
			if (!section) continue;
			const raws = []; // 段内正文行（剥掉段头与空行后的原文，保序）
			const entries = [];
			let confirmed = null;
			for (const line of section.split(/\r?\n/)) {
				const t = line.trim();
				if (!t) continue;
				if (t.startsWith(">")) { // 段头「> 排序确认：日期（确认人）·确认至第N条」——spoor 牌面用，行文牌面不进
					if (t.includes("排序确认")) confirmed = t.replace(/^>\s*/, "");
					continue;
				}
				raws.push(t);
			}
			// 两遍法第一遍：盘点段内既有 v0.9 号位（活人已写的才算「既有」）——①撞号判据与②发号基线以此为准，
			// 与行序无关（旧格式行在段首也能看见段尾的 T6）。
			const claimed = new Set();
			let maxT = 0;
			for (const t of raws) {
				const mm = t.replace(/^[-*+]\s+/, "").match(/^T(\d+)\s*\[/);
				if (mm) { claimed.add(mm[1]); maxT = Math.max(maxT, Number(mm[1])); }
			}
			let nextT = Math.max(maxT, 100); // ②发号基线：100 内是活人手写号段，管线避开（段内无 T 号也从 T101 起）
			const migratedIds = [];
			for (const t of raws) {
				const hadBullet = /^[-*+]\s+/.test(t); // markdown bullet
				const body = hadBullet ? t.replace(/^[-*+]\s+/, "") : t;
				const mItem = body.match(/^T(\d+)\s*\[/); // 待办协议 v0.9 正身
				const mVar = mItem ? null : body.match(/^T(\d+)\s*([^\s\[\]｜]+)\s*\[/); // 旧形状①：裸号后挂装饰后缀（如 T6(新)）
				const mEnum = /^(?:[①-⑳]|\d{1,3}[.、．)）])/.test(body); // 旧牌面序号记法（⑤…／3.…）
				let raw = body, isItem = false, isProse = false, isMigrated = false, note = null;
				if (mItem) isItem = true;
				else if (mVar) {
					// ① 剥装饰后缀取裸号；裸号撞段内既有条目号时加撇保唯一（机械迁移绝不造重号）
					let id = mVar[1];
					if (claimed.has(id)) {
						let primed = id + "'";
						while (claimed.has(primed)) primed += "'";
						id = primed;
						note = `迁移 T${id}·迁移改名`;
					} else note = `迁移 T${id}`;
					claimed.add(id);
					if (Number(mVar[1]) > nextT) nextT = Number(mVar[1]); // ①占的号也进②的发号基线
					raw = `T${id} ${body.slice(mVar[0].length - 1)}`; // 重装 v0.9 号头，余文一字不动
					isItem = true; isMigrated = true;
					migratedIds.push(`T${id}`);
				} else if (hadBullet || mEnum) {
					// ② 裸 bullet 无 ID（⑤第二铲：… 一族）：机械发号=段内既有 T<n> 最大值+1（100 内是活人号段，从 T101 起）
					let n = nextT + 1;
					while (claimed.has(String(n))) n += 1;
					nextT = n;
					claimed.add(String(n));
					raw = `T${n} [] ${body}`; // 归属空着——管形状不造内容，缺栏让三件套机判如实报缺
					isItem = true; isMigrated = true;
					note = `迁移 T${n}`;
					migratedIds.push(`T${n}`);
				} else {
					// ③ 内联散文体：不转（转了是伪造结构），单列非条目（散文段）——不进迁移计数也不进 malformed
					isProse = true;
					note = "非条目·散文段";
				}
				let shown = raw.slice(0, 160);
				if (raw.length > 160) shown += "…";
				if (note) shown += `（${note}）`; // 迁移/散文标注：看牌面的活人要知道这行是管线转的不是原文
				lines.push(`- [${dir}] ${shown}`);
				entries.push({ raw, isItem, note, migrated: isMigrated || undefined, prose: isProse || undefined });
			}
			if (migratedIds.length && !quiet)
				console.log(`[conductor] 牌面迁移：${dir} ${migratedIds.length} 条旧格式→v0.9 形状（${migratedIds.join("·")}）——虚拟迁移只转牌面，STATUS.md 原文不写`);
			if (entries.length || confirmed) boards.push({ project: dir, confirmed, entries });
		}
	} catch (e) {
		if (!quiet) console.warn(`[conductor] ${partId} 牌面预取失败——空牌面降级（拉不到不等于没有）: ${e?.message ?? e}`);
		return null;
	}
	return { projects, lines, boards };
}

// spoor-session 三件套机判（the user 2026-09-25 准入细则拍板）：逐条判「形状」，值不值得动留给分身。
// ①对话出处：出处栏非空且可指回（房间#楼层 如 collab#771，或 session 引用）——光有日期不算指回；
// ②验收判据：判据栏非空且非纯口号——机判代理：含可执行/可观测锚点（跑/验证类动词、命令、判线如全绿/入库）；
// ③到期预算：条目里有日期形状（YYYY-MM-DD 或 N天内——细则只认这两种，9/25 类短写不算）。
// 缺任何一件=跳过：缺X（可多缺并列）；散文段不机判（非条目（散文段）单列）；旧格式经读入侧虚拟迁移
// 成 v0.9 形状后照判（T8）——「格式非法」桶已拆，不装能判的只剩散文。
function judgeSpoorBoard(board) {
	const SRC_SHAPE = /#\d+|session/i; // 房间#楼层 或 session 引用
	const CRIT_SHAPE = /`|npm|node|exit|全对|全绿|全过|通过率|≥|>=|不报|报错|一致|匹配|入库|复测|实测|实跑|跑一|执行|验证|核对|逐条|自查|清单/;
	const DUE_SHAPE = /\d{4}-\d{2}-\d{2}|\d+\s*[天日]内/;
	const groups = [];
	const counts = { ok: 0, skip: 0, lackSource: 0, lackCriteria: 0, lackBudget: 0, migrated: 0, prose: 0 };
	for (const b of board.boards ?? []) {
		const rows = [];
		for (const e of b.entries) {
			if (e.prose) { // 散文段：不是条目——不转不判单列（不进迁移计数，也不进已拆的 malformed）
				counts.prose += 1;
				rows.push({ head: e.raw.slice(0, 60) + (e.raw.length > 60 ? "…" : ""), verdict: "非条目（散文段）·不机判" });
				continue;
			}
			if (e.migrated) counts.migrated += 1; // 虚拟迁移进机判的条数（fetchTodoBoard 读入侧转的）
			const cols = e.raw.split("｜").map((s) => s.trim()); // v0.9：标题｜出处｜判据：…（预算形状可在任一栏）
			const crit = (cols.find((c) => c.startsWith("判据")) ?? "").replace(/^判据[：:]\s*/, "");
			const src = cols.slice(1).find((c) => !c.startsWith("判据")) ?? "";
			const lacks = [];
			if (!src || !SRC_SHAPE.test(src)) lacks.push("缺出处");
			if (!crit || !CRIT_SHAPE.test(crit)) lacks.push("缺判据");
			if (!DUE_SHAPE.test(e.raw)) lacks.push("缺预算");
			const verdict = lacks.length ? `跳过：${lacks.join("·")}` : "够格";
			if (lacks.length) counts.skip += 1; else counts.ok += 1;
			for (const l of lacks) {
				if (l === "缺出处") counts.lackSource += 1;
				else if (l === "缺判据") counts.lackCriteria += 1;
				else counts.lackBudget += 1;
			}
			rows.push({ head: cols[0].slice(0, 60) + (cols[0].length > 60 ? "…" : ""), verdict, mark: e.note });
		}
		if (rows.length) groups.push({ project: b.project, confirmed: b.confirmed, rows });
	}
	return { groups, counts, projects: board.projects };
}

// 牌面指纹（sha256 前 16 位）：boards 结构全量——项目名、排序确认段头、条目原文，一字之动即换指纹。
// 只指纹牌面不指纹裁决：裁决是分身的活，牌面才是「要不要再来一场」的机械依据。
function faceHashBoard(board) {
	return createHash("sha256").update(JSON.stringify(board.boards ?? [])).digest("hex").slice(0, 16);
}

// 报告除鷨度：读 HOTSPOT_OUT 的 generatedAt。缺失/坏 JSON/无时间部 = 无限陈旧（下一场扫描覆盖即自愈）。
function hotspotReportAgeMs() {
	try {
		const j = JSON.parse(fs.readFileSync(HOTSPOT_OUT, "utf8"));
		const t = Date.parse(j?.generatedAt);
		return Number.isFinite(t) ? Date.now() - t : Infinity;
	} catch {
		return Infinity;
	}
}

// hotspot 心跳（seed 抓手①）：报告陈旧即跑扫描器。成败都记账（state.last_hotspot_scan——
// --status 面可见，心跳死没死不用翻 journal 猜）；失败挂 5min 重试冷却。dry-run 只彩排不落盘。
async function heartbeatHotspotScan(st) {
	if (st.hotspot_retry_after && Date.now() < Date.parse(st.hotspot_retry_after)) return { fired: false, why: "retry-cooldown" };
	if (hotspotReportAgeMs() < HOTSPOT_STALE_MS) return { fired: false, why: "fresh" };
	if (DRY) {
		console.log(`[conductor] [dry-run] hotspot 心跳将扫描（报告陈旧 >${Math.round(HOTSPOT_STALE_MS / 3600000)}h）：node src/hotspot-scanner.mjs --dir ${HOTSPOT_DIR} --out ${HOTSPOT_OUT}（纯机械零 LLM，不记抽卡账）`);
		return { fired: false, why: "dry" };
	}
	console.log(`[conductor] hotspot 心跳：报告陈旧（${HOTSPOT_OUT} 无重扫 >${Math.round(HOTSPOT_STALE_MS / 3600000)}h）→ 扫描器上膛（纯机械零 LLM，不记抽卡账）`);
	const t0 = Date.now();
	const r = await new Promise((resolve) => {
		const c = spawn(process.execPath, [path.join(CWD, "src", "hotspot-scanner.mjs"), "--dir", HOTSPOT_DIR, "--out", HOTSPOT_OUT], {
			cwd: CWD, stdio: ["ignore", "pipe", "pipe"],
		});
		let tail = "";
		c.stdout.on("data", (d) => { tail += d.toString(); });
		c.stderr.on("data", (d) => { tail += d.toString(); });
		c.on("error", (e) => resolve({ code: -1, tail: String(e?.message ?? e) }));
		c.on("close", (code) => resolve({ code, tail }));
	});
	let rep = null;
	try { rep = JSON.parse(fs.readFileSync(HOTSPOT_OUT, "utf8")); } catch { /* 扫描器没写成：报告记 null 摘要 */ }
	st.last_hotspot_scan = {
		ts: new Date().toISOString(), exit: r.code, ms: Date.now() - t0,
		hotspots: rep?.hotspots?.length ?? null, errorHotspots: rep?.errorHotspots?.length ?? null, out: HOTSPOT_OUT,
	};
	if (r.code !== 0) {
		st.hotspot_retry_after = new Date(Date.now() + HOTSPOT_RETRY_MS).toISOString();
		console.warn(`[conductor] hotspot 心跳失败 exit=${r.code}——${HOTSPOT_RETRY_MS / 60000}min 后重试（报警不刷屏也不静默）。尾 300 字：\n${r.tail.slice(-300)}`);
	} else {
		delete st.hotspot_retry_after;
		console.log(`[conductor] hotspot 心跳收工：热点 ${st.last_hotspot_scan.hotspots}（错误热点 ${st.last_hotspot_scan.errorHotspots}）落 ${HOTSPOT_OUT}（${st.last_hotspot_scan.ms}ms）`);
	}
	saveState(st);
	return { fired: true, exit: r.code };
}

// retro 触发心跳（v2-2 接线）：消费 evaluateRetroTrigger 三源判定，fire 时拉起 retropad。
// 判据行格式钉死：`[conductor] retro 触发判定：fire=<bool> reason=<threshold|due|hook|none> <detail>`
// （可断言面——测试不翻源码）。报告读侧容错：缺失/坏 JSON → null=按零热点计（retro-trigger
// 自带容错，本接缝不叠加崩）；due 源读 retropad 的状态文件（无历史=立即到期一次，给首战铺路）。
async function heartbeatRetroFire(st) {
	// retro 状态先读（due 源与冷却钟共用一面账——retropad 合法收工写的 lastRetroAt）。
	let retroState = { lastRetroAt: null };
	try { retroState = readRetroState(RETRO_STATE_FILE); } catch (e) { console.warn(`[conductor] retro 状态读坏（当无历史，due 源立即到期一次）：${e?.message ?? e}`); }
	// 冷却闸（连环拉保护，不许省）：上次 fire 至今 < 窗 → 不再 fire（判定也跳——冷却期行为已知，不刷判定行）。
	// 双源取新（2026-10-11 第五班：retropad 首场真弹带外发车，只写 retro/state.json——自家
	// last_retro_fire 不知道 → 自家钟过窗后同一批弹药还能再裁一发）。自家钟保「retropad 崩溃
	// 未落账」的连环拉保护；retroState.lastRetroAt 保「带外合法收工刚裁过」——只认自家会漏别人的账。
	const ownFireMs = Date.parse(st.last_retro_fire?.ts ?? "");
	const ownOk = Number.isFinite(ownFireMs);
	const oobMs = retroState.lastRetroAt; // readRetroState 已归一为 ms（坏 JSON 走 mtime 兜底同形状）
	const oobOk = Number.isFinite(oobMs);
	const cooldownMs = Math.max(ownOk ? ownFireMs : 0, oobOk ? oobMs : 0);
	if (cooldownMs > 0 && Date.now() - cooldownMs < RETRO_COOLDOWN_MS) {
		const clock = ownOk && ownFireMs >= (oobOk ? oobMs : 0)
			? `自家 ${st.last_retro_fire.ts}（reason=${st.last_retro_fire.reason}）`
			: `带外 ${new Date(cooldownMs).toISOString()}（retropad 落账）`;
		console.log(`[conductor] retro 心跳冷却中：上次 fire ${clock}——窗 ${Math.round(RETRO_COOLDOWN_MS / 3600000)}h 内不再拉（连环拉保护）`);
		return { fired: false, why: "cooldown" };
	}
	let report = null;
	try { report = JSON.parse(fs.readFileSync(HOTSPOT_OUT, "utf8")); } catch { /* 缺失/坏 JSON → 零热点面（due/钩子源照判，判定不炸） */ }
	const trig = evaluateRetroTrigger({ report, lastRetroAt: retroState.lastRetroAt });
	console.log(`[conductor] retro 触发判定：fire=${trig.fire} reason=${trig.reason} ${trig.detail}`);
	if (!trig.fire) return { fired: false, why: "none" };
	if (DRY) {
		console.log(`[conductor] [dry-run] retro 心跳将拉起（reason=${trig.reason}）：node ${path.relative(CWD, RETROPAD_BIN)} --report ${HOTSPOT_OUT} --state ${RETRO_STATE_FILE}（不带 --force：retropad 内部幂等复判）`);
		return { fired: false, why: "dry" };
	}
	console.log(`[conductor] retro 心跳：判定 fire（reason=${trig.reason}）→ retropad 上膛（不带 --force：内部幂等复判，双保险；纯机械判定零 LLM，不记抽卡账）`);
	const t0 = Date.now();
	const r = await new Promise((resolve) => {
		// conductor 同款 node 直跑 .mjs（版本错位结构性排除——19连抽钉子钉儿子，同款钉法）
		const c = spawn(process.execPath, [RETROPAD_BIN, "--report", HOTSPOT_OUT, "--state", RETRO_STATE_FILE], {
			cwd: CWD, stdio: ["ignore", "pipe", "pipe"],
		});
		let tail = "";
		c.stdout.on("data", (d) => { tail += d.toString(); });
		c.stderr.on("data", (d) => { tail += d.toString(); });
		c.on("error", (e) => resolve({ code: -1, tail: String(e?.message ?? e) }));
		c.on("close", (code) => resolve({ code, tail }));
	});
	st.last_retro_fire = {
		ts: new Date().toISOString(), reason: trig.reason, detail: trig.detail, exit: r.code, ms: Date.now() - t0,
	};
	if (r.code !== 0) {
		console.warn(`[conductor] retro 心跳失败 exit=${r.code}——冷却窗 ${Math.round(RETRO_COOLDOWN_MS / 3600000)}h 后再战（成败同窗，不刷屏重试）。尾 300 字：\n${r.tail.slice(-300)}`);
	} else {
		console.log(`[conductor] retro 心跳收工：exit=0（${st.last_retro_fire.ms}ms，reason=${trig.reason}）——复盘分身的记账走 retropad/buildRuntime 自己的路线，conductor 不代管`);
	}
	saveState(st);
	return { fired: true, exit: r.code };
}

// ---- 更夫接线（F1，2026-10-18 f1-watchman 单）：死前死后的拉起决策 ----
// 模块动态 import（拔插头验收 1）：src/watchman.mjs 缺失/抛错 → conductor 照跑，重拉决策
// 静默缺席（只出一声 warn）。静态 import 会在启动期直接炸——与「更夫是确定层最小组件、更夫
// 死了宅子照常开灯」的定位相反。CONDUCTOR_WATCHMAN_MODULE：测试/演练换桩（同 CONDUCTOR_PI_BIN 位）。
let WATCHMAN_MOD; // undefined=没试过 / null=拔了 / module=在——进程内只试一次，不每 tick 重探
async function loadWatchmanMod() {
	if (WATCHMAN_MOD !== undefined) return WATCHMAN_MOD;
	try {
		WATCHMAN_MOD = process.env.CONDUCTOR_WATCHMAN_MODULE
			? await import(pathToFileURL(path.resolve(CWD, process.env.CONDUCTOR_WATCHMAN_MODULE)).href)
			: await import("./watchman.mjs");
	} catch (e) {
		WATCHMAN_MOD = null;
		console.warn(`[conductor] 更夫模块不可用（拔插头：照跑不拦，重拉决策静默缺席）：${e?.message ?? e}`);
	}
	return WATCHMAN_MOD;
}

// hearth报备客户端（F1 缘②/spike ⑥）：POST /api/send 大厅，sender=conductor，fetch 超时 5s。
// 失败不拦判定不拦抽卡（spike ⑥ 同款纪律：报备到不到人，账都在盘上）。地址 env HEARTH_URL
// 注入（缺省私有部署hearth）——测试/演练指本地 stub server，不许真打真hearth。
async function hearthSend(text, { url = HEARTH_URL(), timeoutMs = 5000 } = {}) {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const res = await fetch(`${url.replace(/\/$/, "")}/api/send`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ room: "大厅", sender: "conductor", text }),
			signal: ctl.signal,
		});
		if (!res.ok) console.warn(`[conductor] hearth报备非 2xx（${res.status}）——不拦路`);
		return true;
	} catch (e) {
		console.warn(`[conductor] hearth报备失败（${e?.message ?? e}）——不拦判定不拦抽卡`);
		return false;
	} finally {
		clearTimeout(timer);
	}
}

// 停拉转人类（spike ⑥）：hearth报备一条 + spoor journal 落「待审·人」（带死因分类+重拉史+
// 建议动作栏）——不自动做别的。判断只剩最后一公里，这一公里归人。spoor 落账=直接追加
// workbench journal 文件（与 session-spoor workbench_journal 同文件同形状：- **[待审·人]**
// (conductor) HH:MM 文本）——不走 MCP 少一层部署缝；锁粒度从简（stop-human 是罕见事件，
// 与 python 侧 read→拼→写重写的竞争窗口极窄，且报备失败不拦——hearth 是主通道，盘上账都在）。
async function watchmanEscalateHuman(st, { schedId, part, deadRow, reason, attempt }) {
	const led = st.watchman?.relaunches?.[schedId];
	const text = [
		`[conductor 更夫·停拉转人类] schedule #${schedId}（part=${part ?? "?"}）已触顶停拉：${reason}`,
		`死因分类：${deadRow?.signal ? `signal=${deadRow.signal}` : `exit=${deadRow?.exit ?? "?"}`}；最后拉起 ${deadRow?.ts ?? "?"}${Number.isFinite(deadRow?.ms) ? `，运行 ${deadRow.ms}ms` : ""}。`,
		`重拉史（24h 窗）：attempt=${led?.count ?? 0}/${WATCHMAN_MAX}，heal=${led?.healCount ?? 0}；最近死因：${(led?.history ?? []).slice(-3).map((h) => (h.signal ? `signal=${h.signal}` : `exit=${h.exit}`)).join("；") || "（无）"}。`,
		`建议动作：人对一眼会话原文与工件再定补跑/改书/放弃（A3 spool 语义：工件未清，接着干不从头来）。`,
	].join("\n");
	console.log(`[conductor] 更夫停拉转人类：sched #${schedId} attempt=${attempt}/${WATCHMAN_MAX}——hearth报备 + spoor 待审·人（不自动做别的）`);
	emitEvent("escalation.human", { schedId, part: part?.id ?? part ?? null, reason, attempt }, EMIT_OPTS()); // F3 心跳：非hearth听者也听得见停拉
	await hearthSend(text);
	try {
		const root = process.env.CONDUCTOR_STIGMERGY_ROOT ?? path.resolve(CWD, "..", "Stigmergy");
		const day = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10); // 本地日（与 journal 文件名同钟）
		const jf = path.join(root, "workbench", "portalk", "journal", `${day}.md`);
		fs.mkdirSync(path.dirname(jf), { recursive: true });
		const head = fs.existsSync(jf) ? "" : `# ${day}\n`;
		const hhmm = new Date().toTimeString().slice(0, 5);
		fs.appendFileSync(jf, `${head}- **[待审·人]** (conductor) ${hhmm} ${text.replace(/\n/g, " ")}\n`);
		console.log(`[conductor] 更夫停拉转人类：spoor 待审·人已落 ${path.relative(CWD, jf)}`);
	} catch (e) {
		console.warn(`[conductor] spoor 待审·人落账失败（不拦）：${e?.message ?? e}`);
	}
}

// 任务型死状处理（两缝共用：在线死亡分支 + 首 tick 验尸 A 面）：判定→记账→按 verdict 动手。
// relaunch/heal：先写后做（spike ⑤：spawn 前落新 launch 行带 relaunch_of 链——账上可追「这次
// 是替谁跑的」）再 launchPart；重拉又死继续判（链式，台账每次 +1，触顶自然停）。schedule 状态
// 机不碰：entry.status 保持 fired（评估器不认终态的既有语义不动），重拉与否全看更夫账（spike ④）。
async function watchmanHandleTaskDeath(st, { deadRow, part, schedId, buildPrompt, preJudged }) {
	const w = await loadWatchmanMod();
	if (!w) return;
	st.launches ??= []; // 坏形状 state（无 launches 字段）也不炸——补拉要先落行
	let carry = preJudged; // 验尸面已判过的 verdict 直传——同一行只出一行判定账，不双判
	for (;;) {
		const prior = st.watchman?.relaunches?.[schedId];
		const v = carry ?? w.evaluateWatchman({ deadLaunch: deadRow, prior, isTaskLike: true, max: WATCHMAN_MAX, now: Date.now });
		carry = undefined;
		console.log(w.watchmanJudgeLine({ sched: schedId, verdict: v.verdict, reason: v.reason, attempt: v.attempt, max: WATCHMAN_MAX }));
		emitEvent("watchman.judged", { task: `sched:${schedId}`, schedId, verdict: v.verdict, reason: v.reason, attempt: v.attempt, max: WATCHMAN_MAX }, EMIT_OPTS()); // F3 心跳：emit 面不改判定行
		st.watchman ??= {};
		st.watchman.relaunches ??= {};
		st.watchman.relaunches[schedId] = w.recordWatchmanDeath(prior, deadRow, v.verdict, Date.now());
		saveState(st);
		if (v.verdict !== "relaunch" && v.verdict !== "heal") {
			if (v.verdict === "stop-human") await watchmanEscalateHuman(st, { schedId, part: part?.id ?? part, deadRow, reason: v.reason, attempt: v.attempt });
			return; // done/log-only/stop-human：出声即止
		}
		const ranMs = Number.isFinite(Date.parse(deadRow.ts)) ? Date.now() - Date.parse(deadRow.ts) : null;
		const nth = v.verdict === "heal" ? st.watchman.relaunches[schedId].healCount : v.attempt;
		const prompt = w.watchmanRelaunchPrefix({ nth, kind: v.verdict, deadLaunch: { ...deadRow, ms: ranMs } })
			+ "\n\n" + buildPrompt();
		// 先写后做：spawn 前落新 launch 行（relaunch_of 链回指原行 ts）——重拉也死也留名
		const newRow = { day: todayJST(), part: part.id, sched: schedId, ts: new Date().toISOString(), relaunch_of: deadRow.ts };
		st.launches.push(newRow);
		if (st.launches.length > 200) st.launches.shift();
		saveState(st);
		console.log(`[conductor] 更夫${v.verdict === "heal" ? "补拉（环境死，attempt 不计）" : "重拉"}：sched #${schedId} → 新 launch 行已入账（relaunch_of=${deadRow.ts}），带三件套前缀拉起`);
		const r = await launchPart({ ...part, prompt }, (pid) => { newRow.pid = pid; saveState(st); });
		if (r.signal) newRow.signal = r.signal;
		newRow.exit = r.signal ? null : r.code;
		if (r.signal || r.code !== 0) newRow.tail = r.tail; // 死行带尾（三件套下轮用）
		saveState(st);
		if (r.signal) console.error(`[conductor] 更夫重拉 sched #${schedId} 死于信号 ${r.signal}——继续判（尾 300 字）：\n${r.tail.slice(-300)}`);
		else if (r.code !== 0) console.error(`[conductor] 更夫重拉 sched #${schedId} 非零退出 ${r.code}——继续判（尾 300 字）：\n${r.tail.slice(-300)}`);
		else { console.log(`[conductor] 更夫重拉收工：sched #${schedId} exit=0（relaunch_of=${deadRow.ts} 链闭环）`); return; }
		deadRow = { ...newRow }; // 链式：重拉的又死了 → 下一轮判定吃新行（同 sched 同台账）
	}
}

// 班次型死状（抽卡行，spike ②）：判定行照出，log-only 不拉不计数——下轮 tick 自然再抽＝既有
// 正确行为，更夫只补一行判定账。不进台账不报备（日常运转不是承诺）。
async function watchmanNoteShiftDeath({ deadRow, partId }) {
	const w = await loadWatchmanMod();
	if (!w) return;
	const v = w.evaluateWatchman({ deadLaunch: deadRow, prior: undefined, isTaskLike: false, max: WATCHMAN_MAX, now: Date.now });
	console.log(w.watchmanJudgeLine({ part: partId, verdict: v.verdict, reason: v.reason, attempt: v.attempt, max: WATCHMAN_MAX }));
	emitEvent("watchman.judged", { task: `part:${partId}`, partId, verdict: v.verdict, reason: v.reason, attempt: v.attempt, max: WATCHMAN_MAX }, EMIT_OPTS()); // F3 心跳：emit 面不改判定行
}

// 开机首 tick 补验尸（spike ⑤ + ①-补 缝①双面）：
//   A 面（无主行）：launches 里「无 exit 无 signal」的 pending 行（断电孤儿——10/17 v4-3 那类
//   从「连账都没有」变「开机 5 分钟内有人对账」）+ signal=parent-down 补账行（SIGTERM 钩子落
//   的环境死，同样没人收尾）——两类都是环境死，机械判：任务型 heal、班次型出声即止。进程
//   在探针（/proc/<pid>）：conductor 死后 child 可能被 init 收养还活着——活着的不算死，诚实跳过。
//   验过的行落 autopsy 位（幂等：同一行不二次验，重启不重判）。
//   B 面（fired-无行缝，hui #1055 开工条件①）：schedule entries 里 status=fired 的条目 × launches
//   窗口反查（行匹配 sched===entry.id）——无行命中即缝（标完 fired、spawn 前断电，或行被 200
//   行窗口挤出）。它没有行可扫，pending 行扫描永远看不见它，反查才见。双护栏（spike ①-补）：
//   fired_at 距今 >24h 静默忽略（老行早被挤出窗，无护栏反查会把全部历史 fired 当缝报一遍=
//   假阳洪水）；seamShouted 24h 窗幂等（重启不重报）。缝的 verdict 照旧 log-only 不自动补
//   （launches 无行不能证明没跑过，自动补有重复跑风险）——但任务型落缝升档hearth报备（缘②）。
// 异常自己吞不拦抽卡（与 hotspot/retro 心跳同款纪律：骨头断了肉照长）。
async function watchmanFirstTickAutopsy(st) {
	const w = await loadWatchmanMod();
	if (!w) return;
	// A 面：无主行验尸
	for (const l of st.launches ?? []) {
		const pending = l.exit === undefined && l.signal === undefined;
		const parentDown = l.signal === "parent-down";
		if ((!pending && !parentDown) || l.autopsy) continue;
		if (typeof l.pid === "number" && l.pid > 0 && fs.existsSync(`/proc/${l.pid}`)) continue; // 还在跑——诚实跳过
		const isTask = l.sched !== undefined && l.sched !== null;
		if (DRY) { console.log(`[conductor] [dry-run] 更夫验尸将判无主行 ${isTask ? `sched:${l.sched}` : `part:${l.part ?? "?"}`}（彩排不写不拉）`); continue; }
		const prior = isTask ? st.watchman?.relaunches?.[l.sched] : undefined;
		const v = w.evaluateWatchman({ deadLaunch: l, prior, isTaskLike: isTask, max: WATCHMAN_MAX, now: Date.now });
		l.autopsy = new Date().toISOString(); // 幂等位：验过不再验
		if (!isTask || (v.verdict !== "heal" && v.verdict !== "relaunch")) {
			// 班次型：出声即止（下轮 tick 自然再抽）；任务型触顶/隔夜：判定行 + 停拉转人类
			//（不走 handleTaskDeath——那路是补拉路，判定行在这出，一行只出一道账）
			console.log(w.watchmanJudgeLine({ sched: isTask ? l.sched : undefined, part: l.part, verdict: v.verdict, reason: v.reason, attempt: v.attempt, max: WATCHMAN_MAX }));
			saveState(st);
			if (isTask && v.verdict === "stop-human") await watchmanEscalateHuman(st, { schedId: l.sched, part: l.part, deadRow: l, reason: v.reason, attempt: v.attempt });
			continue;
		}
		saveState(st);
		// 任务型 heal/relaunch：判定行/台账/补拉全走 handleTaskDeath（preJudged 直传——同一行
		// 只出一行判定账，不双判）
		{
			const part = PARTS_ALL.find((p) => p.id === l.part);
			if (!part) { console.warn(`[conductor] 更夫验尸：无主行 part=${l.part} 不在牌池——只记验尸位不补拉`); continue; }
			const entry = (readSchedule(SCHEDULE_FILE_PATH()).entries ?? []).find((e) => e?.id === l.sched);
			await watchmanHandleTaskDeath(st, {
				deadRow: l, part, schedId: l.sched, preJudged: v,
				buildPrompt: () => (typeof part.prompt === "function" ? part.prompt(entry?.params) : part.prompt),
				});
		}
	}
	// B 面：fired × launches 反查（缝①）
	const sched = readSchedule(SCHEDULE_FILE_PATH());
	for (const entry of sched.entries ?? []) {
		if (entry?.status !== "fired") continue;
		if ((st.launches ?? []).some((l) => l.sched === entry.id)) continue; // 有行——账在，不进本缝
		const firedMs = Date.parse(entry.fired_at ?? "");
		if (!Number.isFinite(firedMs) || Date.now() - firedMs > w.WATCHMAN_WINDOW_MS) continue; // >24h 静默忽略（假阳洪水防护，spike ①-补）；fired_at 缺失=证不了新鲜，同护栏
		st.watchman ??= {};
		st.watchman.seamShouted ??= {};
		const last = st.watchman.seamShouted[entry.id];
		if (last && Date.now() - Date.parse(last) < w.WATCHMAN_WINDOW_MS) continue; // 24h 窗内已报过（重启不重报）
		if (DRY) { console.log(`[conductor] [dry-run] 更夫验尸将报 fired-无行缝 #${entry.id}（彩排不写不报）`); continue; }
		console.log(w.watchmanJudgeLine({
			sched: entry.id, part: entry.part, verdict: "log-only", attempt: 0, max: WATCHMAN_MAX,
			reason: "fired-无行缝（标完 fired、spawn 前断电/行被窗口挤出）——launches 无行不能证明没跑过，不自动补",
		}));
		st.watchman.seamShouted[entry.id] = new Date().toISOString(); // 报备前先记名：报备失败也不重报（防洪水问一句就够）
		saveState(st);
		// 缘②升档：过了确认线的任务落缝，console 行太轻——hearth报备一条（讣告同款形状），失败不拦
		await hearthSend(`[conductor 更夫·fired-无行缝] schedule #${entry.id}（part=${entry.part ?? "?"}）标完 fired 但 launches 无对应行——死因=fired-无行缝（标完 fired、spawn 前断电，或行被 200 行窗口挤出）。fired_at=${entry.fired_at}。launches 无行不能证明没跑过，请人对一眼再定补不补。`);
	}
}

// ---- F2 收件箱按天清钩子（「开机对账」家族，watchman 验尸同族；只住常驻面）----
// 每天首 tick（进程级日旗：开机首跑 + 日界翻篇再跑）打壳 POST /approvals/sweep——过期 pending
// 审批卡自动转 denied（by=system-expired，壳侧 decide 同形状同审计），清了东西出记账行
//（spec 实现面 4：清了几条、逐条 id+类型——审批单号）。为什么不在 tick() 里挂：--once 是彩排/
// 测试面（大量测试直跑 --once），不能让它对真壳产生真实 deny 副作用——与验收 5「env fail-fast
// 在常驻面」同口径，清理钩子也住常驻面。runtime inbox 的按天清在 orchestrator 自己的 tick
//（runtime.mjs startLoop）——conductor 够不到各 dispatch 进程的内存收件箱，两边各扫各的。
// 帷幕线（spec 语义 3）：本钩子只调壳 sweep，不 spawn 不重派不碰更夫账。壳不可达=旁路：
// 不拦 tick，5min 重试冷却（不刷屏也不静默），壳回来了当天补扫。
const INBOX_TTL_SWEEP = { day: null, retryAfterMs: 0 };
async function inboxTtlDailySweep() {
	const today = nowJstDay();
	if (INBOX_TTL_SWEEP.day === today) return { swept: [], why: "already" };
	if (Date.now() < INBOX_TTL_SWEEP.retryAfterMs) return { swept: [], why: "retry-cooldown" };
	const mode = INBOX_TTL_MODE ?? "day"; // 彩排面非法值已回 day；常驻面非法值进不来（fail-fast）
	if (DRY) {
		console.log(`[conductor] [dry-run] 收件箱按天清将打壳 ${SHELL_URL}/approvals/sweep（mode=${mode}）——彩排不扫不记账`);
		INBOX_TTL_SWEEP.day = today;
		return { swept: [], why: "dry" };
	}
	try {
		const res = await fetch(`${SHELL_URL}/approvals/sweep`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ mode }),
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const out = await res.json();
		INBOX_TTL_SWEEP.day = today;
		INBOX_TTL_SWEEP.retryAfterMs = 0;
		const swept = Array.isArray(out?.swept) ? out.swept : [];
		if (swept.length) console.log(sweepAccountLine("[conductor]", swept));
		return { swept, why: "ok" };
	} catch (e) {
		INBOX_TTL_SWEEP.retryAfterMs = Date.now() + 5 * 60_000;
		console.warn(`[conductor] 收件箱按天清够不着壳（${SHELL_URL}/approvals/sweep）——5min 后重试（不拦 tick，别静默）: ${e?.message ?? e}`);
		return { swept: [], why: "shell-unreachable" };
	}
}

function launchPart(part, onSpawn) {
	return new Promise((resolve) => {
		const env = {
			...process.env,
			PIANIST_AGENT_ID: `pianist-${part.id}-1`,
			PIANIST_SHELL_URL: SHELL_URL,
			NO_COLOR: "1",
			// 钥匙柜供给（T15 活一）：柜有 coding-plan 走柜（落 use-vault 事件）；柜无回落本进程
			// env（过渡态——/etc/pianist/conductor.env 明文是残留面，下线路线见 docs/t15-env-offline.md）。
			// context（T16）：journal 记「用在哪」——哪个 part 在消费这把钥匙。
			ZAI_CODING_CN_API_KEY: envOrVault("ZAI_CODING_CN_API_KEY", "coding-plan", `conductor:launch(${part.id})`),
		};
		// CONDUCTOR_PI_BIN：测试/演练时可换 stub（真拉起走默认 pi）
		const piBin = process.env.CONDUCTOR_PI_BIN ?? "./node_modules/.bin/pi";
		// 钉子②（2026-09-25 尸检发现）：pi 的 shebang 是 `#!/usr/bin/env node`，服务 PATH 里
		// 只有系统 node（v20），engines>=22 的 ESM 一行就炸（当日 32 场 28 场 1 秒死）。
		// 修法：不用 .bin/pi 的 shebang，直接「conductor 同款 node + pi 入口 JS」——
		// 爹用哪个 node 儿子就用哪个，版本错位结构性排除（19连抽钉子钉了爹漏了儿子，这次钉儿子）。
		const piEntry = piBin.endsWith(".mjs") || piBin.endsWith(".js")
			? piBin
			: path.resolve(CWD, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js");
		const child = spawn(process.execPath, [piEntry, "-p", "--model", "zai-coding-cn/glm-5.2", part.prompt], {
			cwd: CWD, env, stdio: ["ignore", "pipe", "pipe"],
		});
		// ① pid 到手即入账（spawn 返回时 pid 已同步可用）——死时验尸少一跳（/proc 探针直接有号）
		if (typeof child.pid === "number") onSpawn?.(child.pid);
		let out = ""; let err = "";
		child.stdout.on("data", (d) => { out += d.toString(); });
		child.stderr.on("data", (d) => { err += d.toString(); });
		// ② 死法一：close 的 signal 非 null = child 被信号杀（此时 code 为 null）——死因随 resolve 带回入账
		child.on("close", (code, signal) => resolve({ code, signal: signal ?? null, tail: (out + "\n" + err).slice(-500) }));
	});
}

// ---- schedule 消费缝（骨头层，2026-10-12 schedule-bone 施工）----
// spec 权威：docs/schedule-spec-v0.1.md（六条拍板）。卡池是肉（闲时随机填充），schedule 是骨头
//（agent 对自己一天的确定性安排）——本缝是骨头的消费位，评估器纯函数在 src/schedule/evaluator.mjs，
// 存储在 src/schedule/store.mjs。拍板落位：①非 cron，走 conductor 日程表（预算/遥测/审批全走
// 既有闸——本缝在预算硬停与忙判之后，抽卡之前）②预算优先级：schedule 先吃——due 条目本 tick
// 直接顶掉抽卡（一 tick 一场，同抽卡节奏），余额留给下一轮 ③权限三档默认 always-ask，生效前走
// ACTION_RISK 分流（evaluator 内复用 queue-core classify，单一事实源）④活动窗 env+文件双通道
//（默认北京 10:00-22:00，agent 自适应是后续活本期只留通道）⑤粒度复合带参数（params 原样透传
// 给 part 的牌面构造）⑥错过=跳过不补跑（LAST 时窗已过→status=skipped 落盘，没有补跑队列）。
// 异常自己吞不拦抽卡——骨头断了肉照长（与 hotspot/retro 心跳同款纪律）。
const SCHEDULE_FILE_PATH = () => process.env.CONDUCTOR_SCHEDULE_FILE ?? path.join(CWD, "data", "schedule", "schedule.json");
const ACTIVE_HOURS_FILE_PATH = () => process.env.CONDUCTOR_ACTIVE_HOURS_FILE ?? path.join(CWD, "data", "schedule", "active-hours.json");
async function consumeSchedule(st, day, today) {
	const file = SCHEDULE_FILE_PATH();
	const sched = readSchedule(file);
	const fileHours = readActiveHoursFile(ACTIVE_HOURS_FILE_PATH());
	const v = evaluateSchedule({
		schedule: sched,
		envTier: process.env.CONDUCTOR_SCHEDULE_PERMISSION,
		envHours: process.env.CONDUCTOR_ACTIVE_HOURS,
		fileHours,
	});
	const aw = v.activeWindow;
	console.log(`[conductor] schedule 判定：due=${v.due.length} skipped=${v.skipped.length} held=${v.held.length} waiting=${v.waiting} terminal=${v.ignored.terminal}（条目 ${sched.entries.length} 张，活动窗 ${aw.start}-${aw.end}@北京 src=${aw.source}${aw.inWindow ? "" : "·窗外"}${aw.invalid.length ? `（${aw.invalid.join("/")}通道值非法已忽略）` : ""}）`);
	// 错过跳过（§五3）：LAST 时窗已过 → status=skipped 持久化——不排队不补跑（cron 同族语义：
	// 机器没开就是没开）。dry-run 只彩排不落盘。
	if (v.skipped.length) {
		const ids = v.skipped.map((s) => `#${s.entry.id}`).join(",");
		if (DRY) {
			console.log(`[conductor] [dry-run] schedule 错过跳过将落：${ids}（时窗已过，不补跑不排队——cron 同族语义）`);
		} else {
			const at = new Date().toISOString();
			for (const s of v.skipped) { s.entry.status = "skipped"; s.entry.skipped_at = at; }
			writeSchedule(file, sched);
			console.log(`[conductor] schedule 错过跳过：${ids}（时窗已过，不补跑不排队——cron 同族语义）`);
		}
	}
	// 被闸拦的窗口命中条目：一行汇总出声（pending-approval=等人批 / red-pending=危险操作挂审批 /
	// outside-active-hours=等活动时段）。被拦的骨头不顶掉抽卡——肉照长。
	if (v.held.length) {
		console.log(`[conductor] schedule 窗口命中但被闸拦 ${v.held.length} 条：${v.held.map((h) => `#${h.entry.id}(${h.why})`).join(" ")}`);
	}
	if (v.ignored.invalid.length) {
		console.warn(`[conductor] schedule 坏形状条目 ${v.ignored.invalid.length} 条（跳过不消费）：${v.ignored.invalid.map((i) => `#${i.id ?? "?"}(${i.why})`).join(" ")}`);
	}
	if (!v.due.length) return null;
	// 一 tick 一场（同抽卡节奏）：due 按 window.start 升序先吃最早窗，多条同燃靠后续 tick 续消。
	const hit = v.due[0];
	const entry = hit.entry;
	const part = PARTS_ALL.find((p) => p.id === entry.part);
	if (!part) {
		console.warn(`[conductor] schedule 条目 #${entry.id} part="${entry.part}" 不在牌池（五张：${PARTS_ALL.map((p) => p.id).join("/")}）——标 failed 不重试（part 取值域=牌池）`);
		if (!DRY) {
			entry.status = "failed";
			entry.fail_reason = `part 不在牌池:${entry.part}`;
			writeSchedule(file, sched);
		}
		return null; // 骨头废了不拦肉——抽卡照走
	}
	// params 透传（§四拍板⑤）：part 的牌面是函数则吃 entry.params（形状契约跟着各 part 的牌面走：
	// 如 tideline-threads 吃 threads 数组、env-event 吃 events 数组），字符串牌面原样用。
	const prompt = typeof part.prompt === "function" ? part.prompt(entry.params) : part.prompt;
	const tierNote = hit.tier === "always-ask" ? "（always-ask·已审批生效）" : hit.tier === "auto-safe" ? `（auto-safe·risk=${hit.risk}）` : "（no-ask）";
	console.log(`[conductor] schedule 到点：#${entry.id} ${entry.window.start} ~ ${entry.window.end} → ${part.id}${tierNote} intent=${JSON.stringify(entry.intent ?? null)}（骨头先吃：本 tick 顶掉抽卡，余额下轮再看）`);
	if (DRY) {
		console.log(`[conductor] [dry-run] schedule 将拉起 ${part.id}（prompt ${String(prompt).length} 字，params=${JSON.stringify(entry.params ?? null)}），不记账不落 status`);
		return { acted: false, why: "dry-schedule" };
	}
	// 消费落账：launch 先写后做（同抽卡路径，行带 sched=<条目id>）；status=fired 在 spawn 前落盘
	//（错过/重复消费由盘上状态挡——评估器不认终态）。预算/遥测/审批全走既有闸（单一入口①）。
	const launchRow = { day: today, part: part.id, sched: entry.id, ts: new Date().toISOString() };
	day.sched_fires = (day.sched_fires ?? 0) + 1;
	st.days[today] = day;
	st.launches.push(launchRow);
	if (st.launches.length > 200) st.launches.shift();
	saveState(st);
	entry.status = "fired";
	entry.fired_at = launchRow.ts;
	writeSchedule(file, sched);
	console.log(`[conductor] 拉起 schedule #${entry.id} → ${part.id} ...（launch 先写后做：pending 行已入账，status=fired 已落盘）`);
	const t0 = Date.now();
	const r = await launchPart({ ...part, prompt }, (pid) => {
		launchRow.pid = pid;
		saveState(st);
	});
	if (r.signal) launchRow.signal = r.signal;
	launchRow.exit = r.signal ? null : r.code;
	if (r.signal || r.code !== 0) launchRow.tail = r.tail; // 死行带尾（≤500 字）——更夫三件套的死因面（spike ③）
	st.last_schedule_fire = { ts: launchRow.ts, id: entry.id, part: part.id, exit: r.signal ? null : r.code, signal: r.signal ?? null, ms: Date.now() - t0 };
	saveState(st);
	if (r.signal) {
		console.error(`[conductor] schedule #${entry.id} ${part.id} 死于信号 ${r.signal}——死因已入账（launch 行 signal 字段），尾 300 字：`);
		console.error(r.tail.slice(-300));
	} else if (r.code !== 0) {
		console.error(`[conductor] schedule #${entry.id} ${part.id} 非零退出 ${r.code}——尾 300 字：`);
		console.error(r.tail.slice(-300));
	} else {
		console.log(`[conductor] schedule #${entry.id} ${part.id} 收工 exit=0（launch 行已回填，status=fired 在盘）`);
	}
	// 更夫判定（F1，spike ⑤）：任务型死状 → 机械判定拉不拉（exit=0 干完死不进——永不重拉）。
	// relaunch/heal 先写后做再拉；stop-human hearth报备+spoor 待审·人。异常自己吞不拦收工路径
	//（拔插头纪律：更夫死了 schedule 照跑）。
	if (r.signal || r.code !== 0) {
		try {
			await watchmanHandleTaskDeath(st, {
				deadRow: { ...launchRow, ms: Date.now() - t0 },
				part, schedId: entry.id,
				buildPrompt: () => (typeof part.prompt === "function" ? part.prompt(entry.params) : part.prompt),
			});
		} catch (e) { console.warn(`[conductor] 更夫判定异常（不拦收工路径）：${e?.message ?? e}`); }
	}
	return { acted: true, why: "schedule", part: part.id, sched: entry.id, exit: r.code, signal: r.signal ?? null };
}

async function tick() {
	const st = loadState();
	const today = todayJST();
	const day = st.days[today] ?? { draws: 0, launches: 0, spend: 0, budgetHit: false };

	// hotspot 心跳在一切早退之前（预算硬停/忙判/冷却都不拦它）：心跳不属抽卡账，预算死日
	// 也不许发现闭环瞎掉；扫描器失败自己挂冷却，不碰下面的抽卡路径。
	try { await heartbeatHotspotScan(st); } catch (e) { console.warn(`[conductor] hotspot 心跳异常（不拦抽卡）：${e?.message ?? e}`); }
	// retro 触发心跳紧跟 hotspot 扫描收工之后（同一 tick：扫描落新报告 → 立刻判 retro；due 源不
	// 依赖报告新鲜度，每 tick 照判）。同款口径：在预算硬停/忙判早退之前（发现闭环不属抽卡账），
	// 异常自己吞不拦抽卡——与 hotspot 心跳一致的节奏。
	try { await heartbeatRetroFire(st); } catch (e) { console.warn(`[conductor] retro 心跳异常（不拦抽卡）：${e?.message ?? e}`); }

	// 更夫开机首 tick 补验尸（F1）：A 面无主行（断电孤儿/parent-down 补账行）+ B 面 fired×launches
	// 反查。在预算硬停/忙判早退之前（验尸不属抽卡账，与心跳同口径）；进程级只跑一次，异常
	// 自己吞不拦抽卡（骨头断了肉照长）。
	if (!WATCHMAN_AUTOPSY.done) {
		WATCHMAN_AUTOPSY.done = true;
		try { await watchmanFirstTickAutopsy(st); } catch (e) { console.warn(`[conductor] 更夫验尸异常（不拦抽卡）：${e?.message ?? e}`); }
	}

	const { spend, n } = dailySpendYen();
	day.spend = spend;
	if (spend >= DAILY_BUDGET) {
		day.budgetHit = true;
		st.days[today] = day;
		saveState(st);
		console.log(`[conductor] 预算硬停：${today} 已烧 ${spend.toFixed(4)}/${DAILY_BUDGET} 元（${n} 场）——当天不再拉`);
		return { acted: false, why: "budget" };
	}

	const { latest, nFiles } = lastActivityMs();
	const idleMs = idleMsOverride() ? IDLE_MS + 1 : Date.now() - latest;
	const idleMin = (idleMs / 60000).toFixed(1);
	if (idleMs <= IDLE_MS) {
		console.log(`[conductor] 忙（last=${idleMin}min 前，files=${nFiles}）——不拉`);
		if (!DRY) { st.days[today] = day; saveState(st); }
		return { acted: false, why: "busy" };
	}

	// schedule 消费（骨头层）：在忙判之后（冲突消解沿用现有 idle 判定——spec §六开放问题不预答）、
	// drawPart 抽卡之前（预算优先级②：骨头先吃，余额才给抽卡）。due 即本 tick 顶掉抽卡拉起。
	try {
		const sr = await consumeSchedule(st, day, today);
		if (sr) return sr;
	} catch (e) { console.warn(`[conductor] schedule 消费异常（不拦抽卡）：${e?.message ?? e}`); }

	// env-event 饿死退避（2026-09-29 wander，09-28 深夜三连红验尸）：预取连续硬失败达阈值 →
	// 当日(JST)停抽该 part。空牌确认跑不因重试而愈——每个空闲窗烧一场只为说「拉不到」，恢复靠修因。
	// 表名缝一改（CONDUCTOR_EVENT_TABLE 变值）即自动解除重探：装的时候看得见，修的时候不用惦记 state。
	const BACKOFF_AFTER = Number(process.env.CONDUCTOR_ENV_BACKOFF_AFTER ?? 3);
	const TABLE_NOW = eventTable();
	if (st.env_event_backoff_day && st.env_event_backoff_table !== undefined && st.env_event_backoff_table !== TABLE_NOW) {
		console.log(`[conductor] env-event 退避缝已改（${st.env_event_backoff_table} → ${TABLE_NOW}）——清退避重探`);
		delete st.env_event_fail_streak; delete st.env_event_backoff_day; delete st.env_event_backoff_table;
		st.days[today] = day; saveState(st);
	}
	const envBackoff = st.env_event_backoff_day === today && PARTS.some((p) => p.id === "env-event");
	if (envBackoff && PARTS.every((p) => p.id === "env-event")) {
		console.log(`[conductor] env-event 今日退避（连续 ${st.env_event_fail_streak ?? "?"} 次预取硬失败，backoff_day=${today}）且无他牌——本轮不抽。修因：no such table → /etc/pianist/conductor.env 写 CONDUCTOR_EVENT_TABLE=<真表名>（次日自动重探）`);
		st.days[today] = day; saveState(st);
		return { acted: false, why: "env-event-backoff" };
	}
	if (envBackoff) console.log(`[conductor] env-event 今日退避（连续 ${st.env_event_fail_streak ?? "?"} 次预取硬失败）——本轮从其余 ${PARTS.length - 1} 牌里抽`);
	// spoor-session 牌面指纹冷却（2026-09-30 wander，09-30 凌晨三连空牌验尸）：当夜 spoor×3+todo-review
	// 四场烧 ~$1.4 全在一张没变的牌面上（三场 spoor 逐字重演同一套探索、同一句「值得动0」）。
	// 门形：上一场 spoor-session 正常收工（exit=0）时记下的牌面指纹与本轮逐字相同，且距今 <
	// 冷却窗 → 本轮不抽它。与 env-event 饿死退避同族——空牌确认跑不因重跑而愈；但裁决含时间维
	// （到期日会走、上游包会到而牌面未必同步动），故牌面一字之变立即恢复资格、冷却窗过后
	// 即使牌面未变也重探。读坏=不冷却（探针静默，降级不算事）。
	const SPOOR_FACE_COOLDOWN_MS = Number(process.env.CONDUCTOR_SPOOR_FACE_COOLDOWN_H ?? 12) * 3600_000;
	const lastSpoor = [...(st.launches ?? [])].reverse().find((l) => l.part === "spoor-session" && l.faceHash && l.exit === 0);
	let pool = envBackoff ? PARTS.filter((p) => p.id !== "env-event") : PARTS;
	if (lastSpoor && pool.some((p) => p.id === "spoor-session") && Date.now() - Date.parse(lastSpoor.ts) < SPOOR_FACE_COOLDOWN_MS) {
		const probe = fetchTodoBoard("spoor-session", true); // 静默探针：只对指纹，读坏=不冷却
		if (probe !== null && faceHashBoard(probe) === lastSpoor.faceHash) {
			pool = pool.filter((p) => p.id !== "spoor-session");
			console.log(`[conductor] spoor-session 牌面指纹未变（${lastSpoor.ts} 已裁，冷却窗 ${Math.round(SPOOR_FACE_COOLDOWN_MS / 3600000)}h 内）——本轮不抽 spoor-session`);
			if (!pool.length) {
				console.log(`[conductor] 可抽的牌全在冷却/退避——本轮不抽（账不动）。牌面一变或冷却窗过即恢复`);
				st.days[today] = day; saveState(st);
				return { acted: false, why: "pool-cooled" };
			}
		}
	}
	const part = drawPart(pool);
	day.draws += 1;

	// env-event：拉起前预取牌面（失败降级空牌面，session 照拉）。dualcard 双游标：本地行/远端行
	// 各拿各的游标进预取，回来时 source 指明本轮行来自哪个源——推游标用（两套行号空间独立）。
	let prompt = part.prompt;
	let events = null;
	let eventSource = null;
	if (part.id === "env-event") {
		const evr = await fetchEnvEvents(st.last_env_event_id ?? 0, st.last_env_event_local_id ?? 0);
		events = evr === null ? null : evr.rows;
		eventSource = evr === null ? null : evr.source;
		prompt = part.prompt(events);
		// 预取硬失败计数：连续 N 次→当日退避（阈值起效的那场照跑——已经拉了；停的是之后的抽）。
		// 次日 backoff_day 过期自然重探——报警声每日复发，不静默永停。
		if (events === null) {
			st.env_event_fail_streak = (st.env_event_fail_streak ?? 0) + 1;
			if (st.env_event_fail_streak >= BACKOFF_AFTER) {
				st.env_event_backoff_day = today;
				st.env_event_backoff_table = TABLE_NOW;
				console.warn(`[conductor] env-event 连续 ${st.env_event_fail_streak} 次预取硬失败——今日退避停抽（次日自动重探）。修因见「病名 no such table」行，不在重试`);
			}
		} else {
			st.env_event_fail_streak = 0;
			delete st.env_event_backoff_day; delete st.env_event_backoff_table;
		}
	}
	// todo-review：拉起前预取 workbench「下一步」牌面（失败降级空牌面，session 照拉）
	let board = undefined;
	if (part.id === "todo-review") {
		board = fetchTodoBoard("todo-review");
		prompt = part.prompt(board);
	}
	// spoor-session：同源牌面 + 三件套机判结果一并注入（机判裁形状，分身裁值不值得动）
	let spoor = undefined;
	let spoorFaceHash = null;
	if (part.id === "spoor-session") {
		board = fetchTodoBoard("spoor-session");
		spoor = board === null ? null : judgeSpoorBoard(board);
		spoorFaceHash = board === null ? null : faceHashBoard(board); // 落进 launch 行：下场同牌面对指纹用
		prompt = part.prompt(board, spoor);
	}
	// tideline-threads：拉起前预取本地 tideline 库 threads 牌面（失败降级空牌面，session 照拉）。
	// 抽中才预取——不进本轮的牌不白拉库（与 env-event 同款注入链：prompt 函数接参数进牌面）。
	let threads = undefined;
	if (part.id === "tideline-threads") {
		threads = fetchThreadsBoard();
		prompt = part.prompt(threads);
	}
	// 抽卡出声：牌面摘要一行（各 part 自己的形状）
	let note = "";
	if (part.id === "env-event") {
		// 双游标（dualcard）：牌面行照旧出「>游标」，本地行走本地游标、远端行走远端游标——形状
		// 不变（既有 env-event 测试断言「牌面 N 条（>N）」原样咬得住），进度各看各的。
		const cur = eventSource === "local" ? (st.last_env_event_local_id ?? 0) : (st.last_env_event_id ?? 0);
		note = `，牌面 ${events === null ? "预取失败降级" : events.length + " 条"}（>${cur}）`;
	}
	else if (part.id === "todo-review") note = `，牌面 ${board === null ? "预取失败降级" : board.lines.length + " 行/" + board.projects + " 项目"}`;
	else if (part.id === "spoor-session") note = `，牌面 ${spoor === null ? "预取失败降级" : `够格${spoor.counts.ok}/跳过${spoor.counts.skip}（缺出处${spoor.counts.lackSource}·缺判据${spoor.counts.lackCriteria}·缺预算${spoor.counts.lackBudget}）·迁移${spoor.counts.migrated}·散文${spoor.counts.prose}/${spoor.projects} 项目`}`;
	else if (part.id === "tideline-threads") note = `，牌面 ${threads === null ? "预取失败降级（库还没长出来）" : threads.length + " 条线索"}`;
	console.log(`[conductor] 空闲 ${idleMin}min > ${IDLE_MS / 60000}min → 抽卡：${part.id}（${part.desc}）${note}`);
	if (DRY) {
		console.log(`[conductor] dry-run：不拉起，不记账。今日 draws=${day.draws}`);
		// 演练面：注入型牌面（env-event/todo-review/spoor-session）的 prompt 整段出声——
		// dry-run 即完整彩排（牌面+机判+纪律全可见）。分叉文案（不可达≠空）从演练面可断言，
		// 测试不翻源码；前缀带 part id 防串台。
		if (part.id === "env-event" || part.id === "todo-review" || part.id === "spoor-session" || part.id === "tideline-threads") console.log(String(prompt).split("\n").map((l) => `[${part.id}-prompt] ${l}`).join("\n"));
		// 死亡最小通道演练面：打印将落的 pending 行与回填计划（彩排不落盘）
		const dryMax = events && events.length ? Math.max(...events.map((e) => e.id)) : null;
		console.log(`[conductor] [dry-run] launch 先写后做预演：将落 pending 行 ${JSON.stringify({ day: today, part: part.id, ts: "(拉起时刻)", pid: "(spawn 后即补)" })}`);
		console.log(`[conductor] [dry-run] 回填计划：收工 → { exit, events: ${JSON.stringify(dryMax)}${part.id === "spoor-session" ? ", faceHash" : ""} }；死路 → signal=死因（信号杀）/ signal="parent-down"（父进程 SIGTERM）`);
		return { acted: false, why: "dry" };
	}

	st.days[today] = day;
	// ① launch 先写后做：spawn 前先落 pending 行 {day,part,ts,pid?}（pid 在 launchPart 回调里补），
	// 收工回填同一行 exit/events/faceHash——现状字段一个不少，形状不变。分身中途死（信号杀/
	// 预算闸/宿主停机）pending 行已在盘上，账上永远知道它启动过。读侧兼容：冷却门找
	// exit===0、退避门只认预取账——pending 行无 exit 字段，天然不构成有效裁决（测试钉死）。
	const launchRow = { day: today, part: part.id, ts: new Date().toISOString() };
	st.days[today].launches += 1; // launch 记在拉起之时（先写后做）——死也入账，不虚记收工
	st.launches.push(launchRow);
	if (st.launches.length > 200) st.launches.shift();
	saveState(st);
	console.log(`[conductor] 拉起 ${part.id} ...（launch 先写后做：pending 行已入账）`);
	const t0 = Date.now();
	const r = await launchPart({ ...part, prompt }, (pid) => {
		launchRow.pid = pid;
		saveState(st);
	});
	const maxEventId = events && events.length ? Math.max(...events.map((e) => e.id)) : null;
	if (events && events.length === 5) {
		// 吃满一轮（ASC LIMIT 5）说明后面可能还有积压——出声，不装消费完
		console.warn(`[conductor] env-event 本轮吃满 5 条（至 #${maxEventId}）——队列可能仍有积压，靠后续轮次续消`);
	}
	// 回填同一行：正常收工 exit=r.code（events/faceHash 原样补齐）；被信号杀 exit=null+
	// signal=死因（SIGTERM/SIGKILL）——与正常收工行形状可区分，读侧 exit===0 判据天然不认死行
	if (r.signal) launchRow.signal = r.signal;
	launchRow.exit = r.signal ? null : r.code;
	launchRow.events = maxEventId;
	if (spoorFaceHash) launchRow.faceHash = spoorFaceHash;
	if (r.signal || r.code !== 0) launchRow.tail = r.tail; // 死行带尾（≤500 字）——更夫判定行的死因面
	// 消费进度推进（dualcard 双游标）：本地行推 last_env_event_local_id、远端行照旧推
	// last_env_event_id——两套行号空间各自续消，谁也不吃谁的进度（独立性测试钉死）。
	// 只记 conductor 自己的 state，不碰源库（只读界约）。
	if (maxEventId !== null) {
		if (eventSource === "local") st.last_env_event_local_id = maxEventId;
		else st.last_env_event_id = maxEventId;
	}
	saveState(st);
	if (r.signal) {
		console.error(`[conductor] ${part.id} 死于信号 ${r.signal}——死因已入账（launch 行 signal 字段），尾 300 字：`);
		console.error(r.tail.slice(-300));
	} else if (r.code !== 0) {
		console.error(`[conductor] ${part.id} 非零退出 ${r.code}——尾 300 字：`);
		console.error(r.tail.slice(-300));
	} else {
		console.log(`[conductor] ${part.id} 收工 exit=0（launch 行已回填）`);
	}
	// 更夫判定（F1，spike ②）：班次型任何死状 → log-only 判定行照出，不拉不计数不报备
	//（下轮 tick 自然再抽＝既有正确行为，更夫只补一行判定账）。异常自己吞不拦抽卡。
	if (r.signal || r.code !== 0) {
		try { await watchmanNoteShiftDeath({ deadRow: { ...launchRow, ms: Date.now() - t0 }, partId: part.id }); } catch (e) { console.warn(`[conductor] 更夫判定异常（不拦收工路径）：${e?.message ?? e}`); }
	}
	return { acted: true, part: part.id, exit: r.code, signal: r.signal ?? null };
}

async function main() {
	// 死亡最小通道②死法二钩子（全模式统一挂）：conductor 自身被 SIGTERM（systemd stop/
	// 预算闸）→ 在途 pending 行补 signal="parent-down" 落盘后再退（writeFileSync 同步写来得及）。
	// --once 也要挂：tick 可能在 await 长命 session（kill 场景二即此形状）；彩排/运维面挂了也无害。
	process.on("SIGTERM", sigtermHandler);
	if (SELFCHECK) { // 彩排模式：同一套判据单跑一面（dry-run 即完整彩排的-house style）
		const r = unitSelfCheck(arg("cgroup-file", "/proc/self/cgroup"));
		console.log(`[conductor] 正典自检：unit=${r.unit ?? "(非systemd)"} enabled=${r.enabled ?? "-"} → ${r.ok ? "通过" : "拒绝"}——${r.reason}`);
		process.exit(r.ok ? 0 : 1);
	}
	if (STATUS) {
		const st = loadState();
		const today = todayJST();
		const { spend, n } = dailySpendYen();
		console.log(JSON.stringify({
			today, budget: DAILY_BUDGET, spendToday: Number(spend.toFixed(4)), nSessionsToday: n,
			day: st.days[today] ?? null, lastLaunches: (st.launches ?? []).slice(-5), lastHotspotScan: st.last_hotspot_scan ?? null, lastRetroFire: st.last_retro_fire ?? null, lastScheduleFire: st.last_schedule_fire ?? null,
			watchman: st.watchman ?? null, // 更夫面（F1）：relaunches/healCount/seamShouted——重拉账不用翻 journal 猜
		}, null, 1));
		return;
	}
	if (ONCE) { await tick(); return; }
	// 正典自检（仅常驻分支：--once/--dry-run/--status 是彩排/运维面，不设卡）：
	// 不过→出声退出。残骸自退 = disable 后无需 stop/重启即达（seed①验收形状）。
	if (process.env.CONDUCTOR_SKIP_UNIT_CHECK !== "1") {
		const chk = unitSelfCheck();
		if (!chk.ok) {
			console.error(`[conductor] 正典自检不过（unit=${chk.unit}）：${chk.reason}——出声退出让位正典。修法：bash deploy/install-conductor.sh（正典化+拆残骸）；确属例外用 CONDUCTOR_SKIP_UNIT_CHECK=1 并在 unit env 写明理由。`);
			process.exit(1);
		}
		console.log(`[conductor] 正典自检通过：${chk.reason}`);
	}
	// F2 env 逃生门 fail-fast（验收 5，常驻面）：非法值出声退出——静默跑歪钟比停机更贵。
	if (INBOX_TTL_MODE == null) {
		console.error(`[conductor] CONDUCTOR_INBOX_TTL="${INBOX_TTL_RAW}" 不认（合法：day|24h|tiered，缺省 day=方案 A 正典）——出声退出（fail-fast）。修法：/etc/pianist/conductor.env 改合法值或删掉该行回默认 day。`);
		process.exit(1);
	}
	console.log(`[conductor] 常驻启动：idle>${IDLE_MS / 60000}min tick=${TICK_MS / 1000}s budget=${DAILY_BUDGET} 元/日(JST) inbox-ttl=${INBOX_TTL_MODE} parts=${PARTS.length} node=${process.execPath} ${process.version}（19连抽事故的钉子：版本错位第一跳出声，不用验尸）`);
	// SIGTERM 钩子已在 main 顶部全模式统一挂（sigtermHandler：在途行补 parent-down 后退）。
	while (true) {
		// F2 每天首 tick 收件箱按天清（常驻面钩子，watchman 验尸同族：在预算硬停/忙判早退之前）。
		try { await inboxTtlDailySweep(); } catch (e) { console.warn(`[conductor] 收件箱按天清异常（不中断）：${e?.message ?? e}`); }
		try { await tick(); } catch (e) { console.warn(`[conductor] tick 异常（不中断）：${e?.message ?? e}`); }
		await new Promise((r) => setTimeout(r, TICK_MS));
	}
}
main();
