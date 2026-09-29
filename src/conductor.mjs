#!/usr/bin/env node
// conductor — §三抽卡制地基（2026-09-24）。空闲>30min→等概率抽part→拉起pi session。
// 裁定（collab-issue）：独立进程不碰壳；对event-queue只读不写；只做§九环境事件消费层。
// 预算：当日(JST)遥测cost.total之和≥上限→当天硬停。
// 用法：常驻 / --once / --once --dry-run / --status
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
function arg(name, dflt) {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return dflt;
	const v = args[i + 1];
	return v === undefined || v.startsWith("--") ? dflt : v;
}
const ONCE = args.includes("--once");
const DRY = args.includes("--dry-run");
const STATUS = args.includes("--status");
const SELFCHECK = args.includes("--self-check");
const CWD = path.resolve(import.meta.dirname, "..");
const SHELL_URL = process.env.PIANIST_SHELL_URL ?? "http://127.0.0.1:8770";
const IDLE_MS = Number(arg("idle-min", "30")) * 60_000;
const TICK_MS = Number(arg("tick-sec", "60")) * 1000;
const DAILY_BUDGET = Number(process.env.CONDUCTOR_DAILY_BUDGET ?? arg("daily-budget", "2"));

function todayJST() {
	return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
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
		].join("\n"),
	},
	{
		id: "env-event",
		desc: "§九环境事件消费（event-queue 慢通道）",
		// 牌面由 conductor 拉起前注入（events 参数）；队列不可达时降级为空牌面确认跑
		prompt: (events) => [
			"你是 Emergence Pianist 的环境事件分身（env-event part）。慢通道轮到你了：event-queue 里有实时环境唤起在排队，你的任务是消费这一批。",
			"",
			"本轮牌面（conductor 预取，含 thread_id/cosine/信号摘录）：",
			events && events.length
				? events.map((e) => `- #${e.thread_id} cos=${e.cosine} [${e.signal_source}] ${e.signal_text.slice(0, 80).replace(/\n/g, " ")} (${e.logged_at})`).join("\n")
				: "（队列不可达或无新事件——本轮降级为空牌面确认跑，写 100 字以内的收尾笔记即可）",
			"",
			"逐条判断：这条环境信号对pianist们最近的活动有没有实质关联——没有就明说「这条不接」；有关联的，把判断写进收尾笔记（200字以内）。",
			"纪律：只消费不动账——event-queue 你只读不写；单 session 预算内闭环。",
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
			"非条目格式的行重点照顾：它们多半是旧格式漂着的债，逐条按三件套裁并点名「待迁移」。",
			"收尾笔记 200 字以内：够格几条、跳过几条（各缺什么）、待迁移几条。",
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
						...g.rows.map((r) => `- ${r.verdict === "够格" ? "✔" : r.verdict.startsWith("跳过") ? "✘" : "？"} ${r.head} —— 机判：${r.verdict}`),
					].join("\n")).join("\n")
					: "（各项目「下一步」段均空——真无债可动，写 100 字以内的收尾笔记即可。）",
			"",
			"三件套机判口径（the user 2026-09-25 准入细则拍板）：①对话出处——出处栏非空且可指回（房间#楼层 或 session 引用）；②验收判据——非纯口号的可检查形状（谁跑/跑什么/什么算过）；③到期预算——有日期形状（YYYY-MM-DD 或 N天内）。缺任何一件=跳过：缺X，如实报不装消费完，也不替 the user 补栏。",
			"",
			"你的裁决：",
			"1. 逐条够格 to do 判断「现在值不值得动」——值得的给一句话理由，不值得的也如实说。",
			"2. AI 侧认领开工的：认领即算协商过（拍板1），但达成共识时必须通知 the user——认领共识经壳的 /notify 知道线出声（认领达成共识时，调用 notify_claim 报备 the user——summary 一句话+牌号；收尾笔记仍要写）。",
			"3. 超预算报死（拍板2）：花钱的事 the user 拍板，时间的事当天值班者拍板——你不替谁拍，只出声。",
			"",
			"收尾笔记（200字内）必须含：够格 N 条/跳过 M 条（各缺什么）/格式非法 J 条（待迁移）；够格里值得动的 K 条及一句话理由；首轮跑全量时附够格名单（T<id> 串即可）供 the user 追认（拍板3：第一轮跑完给全量名单）。",
			"纪律：只读不动账——STATUS.md 不写回、journal 不碰；跳过条不回炉不删；单 session 预算内闭环。",
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
	return (process.env.CONDUCTOR_EVENT_TABLE ?? "event-queue").replace(/"/g, "");
}

// env-event 牌面预取：the-remote event-queue 里 replay_day IS NULL 的实时行（未回放消费的）。
// 失败出声降级为空牌面（拉不到队列 ≠ 队列为空）——session 照拉，牌面标明降级原因。
// 消费进度记在 conductor 自己的 state（last_env_event_id），不碰 event-queue（INSERT-only 界约）。
// 队列语义（collab-issue 钉a 裁定 ASC）：每轮吃最老的 5 条，积压靠后续轮次续消——
// 不会静默跳过任何一条；DESC+max 是快照语义，与「消费进度」的承诺不符。
async function fetchEnvEvents(lastId) {
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
				const rows = (Array.isArray(parsed) ? parsed : []).map((r) => ({
					id: Number(r.id), thread_id: Number(r.thread_id), cosine: r.cosine,
					signal_text: String(r.signal_text ?? ""), signal_source: r.signal_source, logged_at: r.logged_at,
				}));
				resolve(rows);
			}
		});
	});
}

// todo-review 牌面预取：本地 the-workbench workbench 各项目 STATUS.md 的「下一步」段。
// 三件套判断占在 prompt 不在逻辑（洞2刀法，collab-issue/#771 认的形状）——这里只供牌面：
// 抽条目原文+标是否条目格式（T<id> [归属] …｜出处｜判据：…），够不够格由 session 按提示词裁。
// 细则（the-remote:2026-09-25-spoor-session准入细则-草稿.md）2026-09-25 三题裁定转正：
// ①AI认领算协商过+通知义务 ②报死拍板=花钱the user/时间值班者 ③追认有效+第一轮全量名单给她。
// 判据文字已进 prompt，骨架未动——「只换判据不动骨架」照旧成立。
// spoor-session 同源吃 boards（按项目结构化条目+排序确认段头）；三件套机判在 judgeSpoorBoard。
// 读不到=降级 null（拉不到清单≠清单为空）；空段=[]=真无债可审。
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
			const entries = [];
			let confirmed = null;
			for (const line of section.split(/\r?\n/)) {
				const t = line.trim();
				if (!t) continue;
				if (t.startsWith(">")) { // 段头「> 排序确认：日期（确认人）·确认至第N条」——spoor 牌面用，行文牌面不进
					if (t.includes("排序确认")) confirmed = t.replace(/^>\s*/, "");
					continue;
				}
				const body = t.startsWith("- ") ? t.slice(2) : t;
				const isItem = /^T\d+\s*\[/.test(body); // 待办协议 v0.9 条目形状
				let shown = body.slice(0, 160);
				if (body.length > 160) shown += "…";
				if (!isItem) shown += "（非条目格式）";
				lines.push(`- [${dir}] ${shown}`);
				entries.push({ raw: body, isItem });
			}
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
// 缺任何一件=跳过：缺X（可多缺并列）；非条目格式不机判（格式非法·待迁移），不装能判。
function judgeSpoorBoard(board) {
	const SRC_SHAPE = /#\d+|session/i; // 房间#楼层 或 session 引用
	const CRIT_SHAPE = /`|npm|node|exit|全对|全绿|全过|通过率|≥|>=|不报|报错|一致|匹配|入库|复测|实测|实跑|跑一|执行|验证|核对|逐条|自查|清单/;
	const DUE_SHAPE = /\d{4}-\d{2}-\d{2}|\d+\s*[天日]内/;
	const groups = [];
	const counts = { ok: 0, skip: 0, lackSource: 0, lackCriteria: 0, lackBudget: 0, malformed: 0 };
	for (const b of board.boards ?? []) {
		const rows = [];
		for (const e of b.entries) {
			if (!e.isItem) {
				counts.malformed += 1;
				rows.push({ head: e.raw.slice(0, 60) + (e.raw.length > 60 ? "…" : ""), verdict: "格式非法（旧格式，待迁移）" });
				continue;
			}
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
			rows.push({ head: cols[0].slice(0, 60) + (cols[0].length > 60 ? "…" : ""), verdict });
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

function launchPart(part) {
	return new Promise((resolve) => {
		const env = {
			...process.env,
			PIANIST_AGENT_ID: `pianist-${part.id}-1`,
			PIANIST_SHELL_URL: SHELL_URL,
			NO_COLOR: "1",
			ZAI_CODING_CN_API_KEY: process.env.ZAI_CODING_CN_API_KEY,
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
		let out = ""; let err = "";
		child.stdout.on("data", (d) => { out += d.toString(); });
		child.stderr.on("data", (d) => { err += d.toString(); });
		child.on("close", (code) => resolve({ code, tail: (out + "\n" + err).slice(-500) }));
	});
}

async function tick() {
	const st = loadState();
	const today = todayJST();
	const day = st.days[today] ?? { draws: 0, launches: 0, spend: 0, budgetHit: false };

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

	// env-event：拉起前预取牌面（失败降级空牌面，session 照拉）
	let prompt = part.prompt;
	let events = null;
	if (part.id === "env-event") {
		events = await fetchEnvEvents(st.last_env_event_id ?? 0);
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
	// 抽卡出声：牌面摘要一行（各 part 自己的形状）
	let note = "";
	if (part.id === "env-event") note = `，牌面 ${events === null ? "预取失败降级" : events.length + " 条"}（>${st.last_env_event_id ?? 0}）`;
	else if (part.id === "todo-review") note = `，牌面 ${board === null ? "预取失败降级" : board.lines.length + " 行/" + board.projects + " 项目"}`;
	else if (part.id === "spoor-session") note = `，牌面 ${spoor === null ? "预取失败降级" : `够格${spoor.counts.ok}/跳过${spoor.counts.skip}（缺出处${spoor.counts.lackSource}·缺判据${spoor.counts.lackCriteria}·缺预算${spoor.counts.lackBudget}）·格式非法${spoor.counts.malformed}/${spoor.projects} 项目`}`;
	console.log(`[conductor] 空闲 ${idleMin}min > ${IDLE_MS / 60000}min → 抽卡：${part.id}（${part.desc}）${note}`);
	if (DRY) {
		console.log(`[conductor] dry-run：不拉起，不记账。今日 draws=${day.draws}`);
		// spoor-session 演练面：真注入的 prompt 整段出声——dry-run 即完整彩排（牌面+机判+纪律全可见）
		if (part.id === "spoor-session") console.log(String(prompt).split("\n").map((l) => `[spoor-prompt] ${l}`).join("\n"));
		return { acted: false, why: "dry" };
	}

	st.days[today] = day;
	saveState(st);
	console.log(`[conductor] 拉起 ${part.id} ...`);
	const r = await launchPart({ ...part, prompt });
	const maxEventId = events && events.length ? Math.max(...events.map((e) => e.id)) : null;
	if (events && events.length === 5) {
		// 吃满一轮（ASC LIMIT 5）说明后面可能还有积压——出声，不装消费完
		console.warn(`[conductor] env-event 本轮吃满 5 条（至 #${maxEventId}）——队列可能仍有积压，靠后续轮次续消`);
	}
	st.days[today].launches += 1;
	st.launches.push({ day: today, part: part.id, ts: new Date().toISOString(), exit: r.code, events: maxEventId, ...(spoorFaceHash ? { faceHash: spoorFaceHash } : {}) });
	if (st.launches.length > 200) st.launches.shift();
	// 消费进度推进：只记 conductor 自己的 state，不碰 event-queue（只读界约）
	if (maxEventId !== null) st.last_env_event_id = maxEventId;
	saveState(st);
	if (r.code !== 0) {
		console.error(`[conductor] ${part.id} 非零退出 ${r.code}——尾 300 字：`);
		console.error(r.tail.slice(-300));
	} else {
		console.log(`[conductor] ${part.id} 收工 exit=0`);
	}
	return { acted: true, part: part.id, exit: r.code };
}

async function main() {
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
			day: st.days[today] ?? null, lastLaunches: (st.launches ?? []).slice(-5),
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
	console.log(`[conductor] 常驻启动：idle>${IDLE_MS / 60000}min tick=${TICK_MS / 1000}s budget=${DAILY_BUDGET} 元/日(JST) parts=${PARTS.length} node=${process.execPath} ${process.version}（19连抽事故的钉子：版本错位第一跳出声，不用验尸）`);
	// SIGTERM 钩子（施工③常驻化，systemd stop 卫生）：默认死法也能停，但 journal 留 signal 尸检——
	// 收工一行再 exit 0，重启/停止的账目干净。仅此 2 行，不碰循环逻辑。
	process.on("SIGTERM", () => { console.log("[conductor] SIGTERM——收工退出（systemd stop）"); process.exit(0); });
	while (true) {
		try { await tick(); } catch (e) { console.warn(`[conductor] tick 异常（不中断）：${e?.message ?? e}`); }
		await new Promise((r) => setTimeout(r, TICK_MS));
	}
}
main();
