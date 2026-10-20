/**
 * watchman.mjs — 更夫重拉判定（F1 施工，2026-10-18 spec docs/f1-watchman-spec-v0.1.md）
 *
 * 是什么：launch 死了之后的机械重拉决策——纯函数、零 IO、零 LLM、零 spawn、时钟注入可测
 *（对齐 retro-trigger.mjs 样板）。讣告（obituary.mjs）管死后的账，更夫管死前后的拉起决策：
 * 拉不拉、拉几次、什么时候停手转人类。接线全在 conductor.mjs（两处死亡分支 + 开机首 tick
 * 验尸 A/B 面 + hearth报备），本模块只判不动手。
 *
 * 输入分类（spec ② 裁决缝）：「错过跳过不补跑」管从未拉起的（schedule 骨头正典不动），
 * 「补拉」管拉起过死掉的——launches 表有无该 sched id 的行是唯一裁决判据：
 *   - 任务型（launches 行带 sched 字段=consumeSchedule 拉起）：死了必扶（确认集语义——
 *     schedule 条目进门都过the user/排序确认线，确认集必收尾自动扶）
 *   - 班次型（tick 抽卡行，无 sched）：任何死状 log-only——下轮 tick 自然再抽=既有正确
 *     行为，更夫只补一行判定账不改行为、不进台账不报备（日常运转不是承诺）
 *
 * 死因分类（spec ① 机械五分，全部可测）：
 *   done        exit===0                    干完死，永不重拉（钉死）
 *   crash       exit!==0 且 signal 空        出错死（非确定性）
 *   killed      signal 非 null 且≠parent-down  信号杀（非确定性）
 *   parent-down signal==='parent-down'      父进程停机死（环境死，不算 session 的错）
 *   orphan      无 exit 无 signal            断电孤儿（环境死——10/18 v4-3 案：这类原来连账都没有）
 *
 * attempt 台账（spec ④）：prior 是单条账 {count, firstTs, lastTs, history, healCount,
 * healFirstTs, healLastTs}——crash 账（count）与 heal 账（healCount）分本独立计数，同 24h
 * 滑动窗（firstTs/healFirstTs 各自出窗各自清零重起算——环境病好了该让跑）；环境死不进
 * crash 账（机器的错不算 session 的错），但 heal 连续达上限同样停拉转人类（防断电-补拉-
 * 又断电无限重启循环）。schedule store 零改动：entry.status 保持 fired 语义，重拉与否全看
 * 本账。attempt 字段语义=crash 账视角（relaunch→count+1；heal→0；stop-human→触发账封顶值）。
 *
 * 孤儿新鲜度护栏（spec ⑤）：无终态行的行龄（launch 行 ts）距今 >24h → 首验即转待审·人
 * 不补（隔夜太久的半成品，收尾权归人——确认集要收尾，但超过一天的收尾权归人）。
 *
 * 边界：不碰壳接口、不碰 schedule store、不 spawn、不读写文件、不发网络。坏形状输入
 *（null 行/垃圾 prior/垃圾 max）回落不抛——纯函数不抛脏输入（同 retro-trigger 容错口径；
 * 拔插头纪律在 conductor 侧另有一层 catch 兜底）。
 */

/** verdict 全集（顺序钉死——判据行枚举与测试断言面） */
export const WATCHMAN_VERDICTS = ["relaunch", "heal", "stop-human", "log-only", "done"];

/** 默认重拉上限（spec ⑥ 架构 v2 第 5 条；env CONDUCTOR_WATCHMAN_MAX 注入 conductor 侧——上限真在读） */
export const DEFAULT_WATCHMAN_MAX = 3;

/** 24h 滑动窗（crash 账/heal 账/孤儿新鲜度/fired-无行缝护栏，同一把尺） */
export const WATCHMAN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** 时间值归一：ms 数字 | ISO 字符串 | Date → ms；不可解析 → null */
function toMs(v) {
	if (v == null) return null;
	if (v instanceof Date) return v.getTime();
	if (typeof v === "number") return Number.isFinite(v) ? v : null;
	if (typeof v === "string") {
		const t = Date.parse(v);
		return Number.isNaN(t) ? null : t;
	}
	return null;
}

const hrs = (ms) => Math.round(ms / 3600000);

/**
 * 死因分类（spec ① 五分表）。坏形状（null/非对象）按 orphan 回落不抛——无终态可证，
 * 交给环境死路径（heal 面向确认集，保守向多扶不少扶）。
 * @param {object|null} l launch 行（{exit, signal, ...}）
 * @returns {{ kind: "done"|"crash"|"killed"|"parent-down"|"orphan", exit, signal }}
 */
export function classifyDeathLaunch(l) {
	if (!l || typeof l !== "object") return { kind: "orphan", exit: undefined, signal: undefined };
	if (l.exit === 0) return { kind: "done", exit: l.exit, signal: l.signal };
	if (l.exit === undefined && l.signal === undefined) return { kind: "orphan", exit: l.exit, signal: l.signal };
	if (l.signal === "parent-down") return { kind: "parent-down", exit: l.exit, signal: l.signal };
	if (l.signal != null) return { kind: "killed", exit: l.exit, signal: l.signal };
	return { kind: "crash", exit: l.exit, signal: l.signal };
}

/**
 * 台账滑窗（spec ④ 24h 滑动）：crash 窗锚 firstTs、heal 窗锚 healFirstTs——各自出窗各自
 * 清零重起算（新的一天新的三次机会——环境病好了该让跑）。两本账同一把尺独立滑动：crash
 * 出窗不连坐 heal 账，反之亦然。返回滑窗后的有效账（不 mutate 入参）；坏形状/null 当无历史。
 * @returns {{ count, firstTs, lastTs, history, healCount, healFirstTs, healLastTs }}
 */
export function slideWatchmanLedger(prior, now = Date.now()) {
	const nowMs = toMs(typeof now === "function" ? now() : now) ?? Date.now();
	if (!prior || typeof prior !== "object") {
		return { count: 0, firstTs: null, lastTs: null, history: [], healCount: 0, healFirstTs: null, healLastTs: null };
	}
	const out = {
		count: Number.isFinite(prior.count) ? prior.count : 0,
		firstTs: toMs(prior.firstTs),
		lastTs: toMs(prior.lastTs),
		history: Array.isArray(prior.history) ? prior.history : [],
		healCount: Number.isFinite(prior.healCount) ? prior.healCount : 0,
		healFirstTs: toMs(prior.healFirstTs),
		healLastTs: toMs(prior.healLastTs),
	};
	if (out.firstTs != null && nowMs - out.firstTs > WATCHMAN_WINDOW_MS) { out.count = 0; out.firstTs = null; }
	if (out.healFirstTs != null && nowMs - out.healFirstTs > WATCHMAN_WINDOW_MS) { out.healCount = 0; out.healFirstTs = null; }
	return out;
}

/**
 * 更夫判定主体（纯函数，时钟注入，零 IO 零 LLM）。
 * @param {object} p
 * @param {object|null} [p.deadLaunch]  死行（launches 行形状 {day,part,ts,pid,exit,signal,events,sched?,tail?,ms?}）
 * @param {object|null} [p.prior]       该 sched 的台账单条（state.watchman.relaunches[schedId]）
 * @param {boolean} [p.isTaskLike]      任务型（行带 sched）——死了必扶；班次型任何死状 log-only
 * @param {number} [p.max]              重拉上限（缺省 3；垃圾值回落 3——纯函数不抛脏输入）
 * @param {number|Function} [p.now]     时钟注入
 * @returns {{ verdict, attempt, reason, death }}
 *   attempt 语义：relaunch→crash 账 count+1；heal→0（机器的错不进 session 的账）；stop-human→
 *   触发账的封顶值 min(count+1,max)（判据行 attempt=N/M 面在此钉死）。
 */
export function evaluateWatchman({ deadLaunch, prior, isTaskLike, max, now = Date.now } = {}) {
	const m = Number.isFinite(max) && max >= 1 ? Math.floor(max) : DEFAULT_WATCHMAN_MAX;
	const nowMs = toMs(typeof now === "function" ? now() : now) ?? Date.now();
	const cls = classifyDeathLaunch(deadLaunch);
	// 干完死优先于一切：exit=0 任何 prior/上限下永不重拉（验收 2 钉死）
	if (cls.kind === "done") {
		return { verdict: "done", attempt: 0, death: cls.kind, reason: `干完死 exit=0——永不重拉（钉死）` };
	}
	// 班次型：任何死状 log-only——不拉不计数不报备（下轮 tick 自然再抽=既有正确行为）
	if (!isTaskLike) {
		return { verdict: "log-only", attempt: 0, death: cls.kind, reason: `班次型死状=${cls.kind}——不拉不计数，下轮 tick 自然再抽（日常运转不是承诺）` };
	}
	const led = slideWatchmanLedger(prior, nowMs);
	// 环境死（parent-down / 断电孤儿）：heal 补拉不计 crash 账；healCount 独立计数防循环；
	// 孤儿带行龄 24h 新鲜度护栏（隔夜半成品收尾权归人——spec ⑤）
	if (cls.kind === "parent-down" || cls.kind === "orphan") {
		if (cls.kind === "orphan") {
			const tsMs = toMs(deadLaunch?.ts);
			if (tsMs != null && nowMs - tsMs > WATCHMAN_WINDOW_MS) {
				return { verdict: "stop-human", attempt: Math.min(led.healCount + 1, m), death: cls.kind,
					reason: `断电孤儿行龄 ${hrs(nowMs - tsMs)}h > ${hrs(WATCHMAN_WINDOW_MS)}h（新鲜度护栏）——隔夜半成品收尾权归人，转待审·人不补` };
			}
		}
		const healAttempt = led.healCount + 1;
		if (healAttempt > m) {
			return { verdict: "stop-human", attempt: Math.min(healAttempt, m), death: cls.kind,
				reason: `环境死累计 heal=${led.healCount}/${m}（24h 滑窗）——防断电-补拉-又断电无限循环，停拉转人类（待审·人）` };
		}
		return { verdict: "heal", attempt: 0, death: cls.kind,
			reason: `环境死(${cls.kind})——机器的错不算 session 的错，补拉不计 crash 账（heal 第 ${healAttempt} 次）` };
	}
	// crash / killed（非确定性死）：relaunch 重拉，crash attempt 计数，注入三件套
	const attempt = led.count + 1;
	if (attempt > m) {
		return { verdict: "stop-human", attempt: Math.min(attempt, m), death: cls.kind,
			reason: `死状=${cls.kind} 累计 ${led.count}/${m} 次（24h 滑窗）达上限——停拉转人类（待审·人）` };
	}
	return { verdict: "relaunch", attempt, death: cls.kind,
		reason: `死状=${cls.kind}${cls.kind === "killed" ? ` signal=${cls.signal}` : ` exit=${cls.exit}`}——重拉注入三件套` };
}

/**
 * 死亡落账（纯函数，返回新台账不 mutate）：verdict=relaunch → crash 账 count+1；verdict=heal →
 * heal 账 healCount+1（history 条目带 heal:true 标记）；其他 verdict（stop-human/done/log-only）
 * 不 bump——判定行出声即账止（触顶那一次死不虚记一次拉起）。两本账独立：heal 落账不动
 * count/firstTs，crash 落账不动 healCount/healFirstTs（验收 3：parent-down 不计数）。
 * history 条目形状 {ts, exit, signal, tail300, heal?}（spec ④），最多留 10 条；tail300 截 300 字。
 * @returns 滑窗+落账后的新台账（firstTs/lastTs 为 ms 数字）
 */
export function recordWatchmanDeath(prior, deadRow, verdict, now = Date.now()) {
	const nowMs = toMs(typeof now === "function" ? now() : now) ?? Date.now();
	const led = slideWatchmanLedger(prior, nowMs);
	if (verdict !== "relaunch" && verdict !== "heal") return led;
	const entry = {
		ts: nowMs,
		exit: deadRow?.exit ?? null,
		signal: deadRow?.signal ?? null,
		tail300: String(deadRow?.tail ?? "").slice(-300),
	};
	if (verdict === "heal") {
		return {
			...led,
			healCount: led.healCount + 1, healFirstTs: led.healFirstTs ?? nowMs, healLastTs: nowMs,
			history: [...led.history, { ...entry, heal: true }].slice(-10),
		};
	}
	return {
		...led,
		count: led.count + 1, firstTs: led.firstTs ?? nowMs, lastTs: nowMs,
		history: [...led.history, entry].slice(-10),
	};
}

/**
 * 判据行（格式钉死，可断言面——测试不翻源码）：
 * `[conductor] 更夫判定：task=<sched:N|part:X> verdict=<relaunch|heal|stop-human|log-only|done> reason=<...> attempt=N/3`
 * sched 与 part 二选一（sched 在场=任务型，否则班次型 part 标签）；reason 须单行无换行。
 */
export function watchmanJudgeLine({ sched, part, verdict, reason, attempt = 0, max = DEFAULT_WATCHMAN_MAX } = {}) {
	const task = sched !== undefined && sched !== null ? `sched:${sched}` : `part:${part ?? "?"}`;
	return `[conductor] 更夫判定：task=${task} verdict=${verdict} reason=${String(reason ?? "").replace(/\n/g, " ")} attempt=${attempt}/${max}`;
}

/**
 * 三件套注入（spec ③：重拉时 prompt 前缀，不是任务书改写）——死因+死前进度+A3 spool 语义。
 * kind=heal 标题分叉（环境死补拉·attempt 不计说在脸上）；死行无尾/无游标降级形状不炸。
 * 进度账 v0.1 从简：launch 行自带字段全给（ts/ms/events 游标）+死行尾 300 字。
 */
export function watchmanRelaunchPrefix({ nth, kind = "relaunch", deadLaunch = {} } = {}) {
	const l = deadLaunch ?? {};
	const title = kind === "heal"
		? `【更夫补拉·环境死第 ${nth} 次】（机器的错不算 session 的错，crash attempt 不计）`
		: `【更夫重拉·第 ${nth} 次尝试】`;
	const cause = l.signal != null ? `signal=${l.signal}` : `exit code=${l.exit ?? "?"}`;
	const tail = typeof l.tail === "string" && l.tail.length ? l.tail.slice(-300) : null;
	const msOk = Number.isFinite(l.ms);
	return [
		title,
		`- 死因：${cause} ＋ 尾 300 字：${tail ?? "（无输出尾）"}`,
		`- 死前进度：上次拉起 ${l.ts ?? "?"}${msOk ? `，运行 ${Math.round(l.ms)}ms` : ""}，事件游标 ${l.events ?? "无"}`,
		`- 上次会话工作区工件未被清理，接着干，不从头来（A3 spool 语义）`,
	].join("\n");
}
