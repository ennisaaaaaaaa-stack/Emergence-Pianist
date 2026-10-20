// v2-2 第一铲：retro-trigger 触发器三源测试（纯逻辑零 LLM——不 spawn、不网络、时钟全注入）。
// 突变敏感（复验者亲手掰，本测试负责红）：
//   - 拆掉热点阈值接线（threshold 分支删）→ 源1 组必红；
//   - 拆掉裁决回灌（源1 改回总数判定/liveHotspotTotal 换 hotspotTotal）→ 源1·回灌组必红；
//   - 拆掉抽检到期接线（due 分支删/无历史不立即到期）→ 源2 组必红；
//   - 拆掉收尾钩子接线（hook 分支删）→ 源3 组必红；
//   - 状态文件读取拆掉（readRetroState 永远回 none）→ 状态文件组必红。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const { evaluateRetroTrigger, hotspotTotal, isLiveShape, readRetroState, writeRetroState, createSessionEndHook,
	DEFAULT_HOTSPOT_THRESHOLD, DEFAULT_RETRO_INTERVAL_MS, RETRO_TRIGGER_REASONS } =
	await import("../src/orchestrator/retro-trigger.mjs");

let pass = 0, total = 0;
function check(name, ok, extra) {
	total++;
	if (ok) pass++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra !== undefined && !ok ? " — " + extra : ""}`);
}

const T0 = Date.parse("2026-10-10T08:00:00.000Z");
const HOUR = 3_600_000;
const reportOf = (n, e = 0) => ({
	v: 1,
	hotspots: Array.from({ length: n }, (_, i) => ({ agent: `a${i}`, occurrences: 9 })),
	errorHotspots: Array.from({ length: e }, (_, i) => ({ agent: `e${i}`, count: 9 })),
});

// ============ 0) 常量与缺省 ============
check("形状：reason 词法四值（threshold/due/hook/none）",
	RETRO_TRIGGER_REASONS.join() === ["threshold", "due", "hook", "none"].join());
check("形状：缺省阈值 3、缺省间隔 6h（蓝图 §5 建议值；间隔 v0 不拍死实战调）",
	DEFAULT_HOTSPOT_THRESHOLD === 3 && DEFAULT_RETRO_INTERVAL_MS === 6 * HOUR);
check("输出形状：{fire:boolean, reason, detail:string} 四件齐",
	(() => { const r = evaluateRetroTrigger({ report: reportOf(0), lastRetroAt: T0 - HOUR, now: T0 }); return typeof r.fire === "boolean" && typeof r.detail === "string" && RETRO_TRIGGER_REASONS.includes(r.reason); })());

// ============ 1) 源1：热点阈值（独立触发；阈值可注入；errorHotspots 计入总数） ============
{
	const r = evaluateRetroTrigger({ report: reportOf(3), lastRetroAt: T0 - HOUR, now: T0 });
	check("源1：热点 3 ≥ 阈值 3 → fire reason=threshold（到期未至也触发——独立源）",
		r.fire === true && r.reason === "threshold", JSON.stringify(r));
	const r2 = evaluateRetroTrigger({ report: reportOf(0, 3), lastRetroAt: T0 - HOUR, now: T0 });
	check("源1：errorHotspots 计入总数（0 重复+3 错误=3 → threshold）",
		r2.fire === true && r2.reason === "threshold", JSON.stringify(r2));
	const r3 = evaluateRetroTrigger({ report: reportOf(4), threshold: 5, lastRetroAt: T0 - HOUR, now: T0 });
	check("源1：阈值可注入（5 时 4 个不燃）", r3.fire === false && r3.reason === "none", JSON.stringify(r3));
	const r4 = evaluateRetroTrigger({ report: reportOf(5), threshold: 5, lastRetroAt: T0 - HOUR, now: T0 });
	check("源1：注入阈值 5 时 5 个燃 threshold", r4.fire === true && r4.reason === "threshold");
	const rZero = evaluateRetroTrigger({ report: reportOf(0), lastRetroAt: T0 - HOUR, now: T0 });
	check("源1·阴性：零热点不达阈值（fire=false——阈值源不许凭空造事件）",
		rZero.fire === false && rZero.reason === "none", JSON.stringify(rZero));
	check("源1：hotspotTotal 对 null/形状坏按 0 计不炸", hotspotTotal(null) === 0 && hotspotTotal({}) === 0 && hotspotTotal(reportOf(2, 1)) === 3);
}

// ============ 1b) 源1·裁决回灌（2026-10-11 wander 认领当晨种子「源①永真」） ============
const reportTs = (tsList) => ({
	v: 1,
	hotspots: [],
	errorHotspots: tsList.map((ts, i) => ({ agent: `e${i}`, shape: `s${i}`, count: 9, lastTs: ts })),
});
{
	const ADJ = T0 - 2 * HOUR; // 上次合法裁决：2h 前（未到 due）
	const stale = reportTs([new Date(ADJ - HOUR).toISOString(), new Date(ADJ - 30 * 60_000).toISOString(), new Date(ADJ - 60_000).toISOString()]);
	const r = evaluateRetroTrigger({ report: stale, lastRetroAt: ADJ, now: T0 });
	check("回灌：3 形状全是裁决前旧账 → live=0 不 threshold（到期未至也不 due → none）",
		r.fire === false && r.reason === "none" && /0\/3/.test(r.detail), JSON.stringify(r));
	const dueCase = evaluateRetroTrigger({ report: reportTs([new Date(T0 - 8 * HOUR).toISOString(), new Date(T0 - 7.5 * HOUR).toISOString(), new Date(T0 - 7 * HOUR - 60_000).toISOString()]), lastRetroAt: T0 - 7 * HOUR, now: T0 });
	check("回灌：旧账不抢 threshold 名分——到期走 due（reason 报真实源，不冒名）",
		dueCase.fire === true && dueCase.reason === "due", JSON.stringify(dueCase));
}
{
	const ADJ = T0 - 7 * HOUR; // 已过 due，隔离观察源1 自身
	const revived1 = reportTs([new Date(ADJ - HOUR).toISOString(), new Date(ADJ - 60_000).toISOString(), new Date(T0 - 30 * 60_000).toISOString()]);
	const r1 = evaluateRetroTrigger({ report: revived1, lastRetroAt: ADJ, now: T0 });
	check("复活：3 形状 1 个裁决后有新事 → live=1 <3 不 threshold（到期走 due，detail 报 1/3）",
		r1.fire === true && r1.reason === "due" && /1\/3/.test(r1.detail), JSON.stringify(r1));
	const revived3 = reportTs([new Date(T0 - 60_000).toISOString(), new Date(T0 - 30 * 60_000).toISOString(), new Date(T0 - 10 * 60_000).toISOString()]);
	const r3 = evaluateRetroTrigger({ report: revived3, lastRetroAt: ADJ, now: T0 });
	check("复活：3 形状全部裁决后有新事 → threshold 重燃（新错形不被旧裁决掩埋）",
		r3.fire === true && r3.reason === "threshold" && /3\/3/.test(r3.detail), JSON.stringify(r3));
}
{
	const noHist = evaluateRetroTrigger({ report: reportTs([new Date(T0 - 100 * HOUR).toISOString(), new Date(T0 - 99 * HOUR).toISOString(), new Date(T0 - 98 * HOUR).toISOString()]), lastRetroAt: null, now: T0 });
	check("无历史：lastRetroAt=null 全按活计（首战铺路不被回灌卡死）",
		noHist.fire === true && noHist.reason === "threshold", JSON.stringify(noHist));
	const mixed = evaluateRetroTrigger({ report: { v: 1, hotspots: [{ agent: "a", occurrences: 9 }, { agent: "b", occurrences: 9 }, { agent: "c", occurrences: 9 }], errorHotspots: [{ agent: "e", shape: "s", count: 9, lastTs: new Date(T0 - 10 * HOUR).toISOString() }] }, lastRetroAt: T0 - 2 * HOUR, now: T0 });
	check("异形保守：缺 lastTs 的形状按活计（年龄不明多燃不少燃；旧账 1 个不计）",
		mixed.fire === true && mixed.reason === "threshold" && /3\/4/.test(mixed.detail), JSON.stringify(mixed));
}

// ============ 1c) isLiveShape（活判单一事实源：触发器计数与 retropad 任务书标记共用） ============
{
	const ADJ = T0 - 2 * HOUR;
	const spot = (ts) => ({ agent: "e", shape: "s", count: 9, lastTs: ts });
	check("活判：lastTs 晚于裁决时刻 → 活", isLiveShape(spot(new Date(ADJ + 60_000).toISOString()), ADJ) === true);
	check("活判：lastTs 早于裁决时刻 → 旧账", isLiveShape(spot(new Date(ADJ - 60_000).toISOString()), ADJ) === false);
	check("活判边界：lastTs 恰等于裁决时刻 → 旧账（裁决那刻的事件已进本次裁决，非裁决后新事）",
		isLiveShape(spot(new Date(ADJ).toISOString()), ADJ) === false);
	check("活判保守：缺 lastTs / 坏 lastTs → 按活（年龄不明多燃不少燃）",
		isLiveShape({ agent: "e" }, ADJ) === true && isLiveShape(spot("t1"), ADJ) === true);
	check("活判保守：无历史（sinceMs 非法）→ 全按活（首战铺路）",
		isLiveShape(spot(new Date(ADJ - HOUR).toISOString()), null) === true && isLiveShape(spot(new Date(ADJ - HOUR).toISOString()), NaN) === true);
	check("活判一致性：isLiveShape 逐形状计数 === liveHotspotTotal（两侧同源不漂移）",
		(() => { const rep = reportTs([new Date(ADJ + 60_000).toISOString(), new Date(ADJ - 60_000).toISOString(), "t0"]); return [true, false, true].every((want, i) => isLiveShape(rep.errorHotspots[i], ADJ) === want); })());
}

// ============ 2) 源2：抽检到期（无历史=立即到期一次；到期判定；时钟注入） ============
{
	const rNoHist = evaluateRetroTrigger({ report: reportOf(1), lastRetroAt: null, now: T0 });
	check("源2：无历史 → 立即到期一次（给首战铺路——热点 1<3 也 fire）",
		rNoHist.fire === true && rNoHist.reason === "due", JSON.stringify(rNoHist));
	const rDue = evaluateRetroTrigger({ report: reportOf(1), lastRetroAt: T0 - 6 * HOUR, now: T0 });
	check("源2：上次复盘 6h 前 ≥ 间隔 6h → fire reason=due",
		rDue.fire === true && rDue.reason === "due", JSON.stringify(rDue));
	const rEdge = evaluateRetroTrigger({ report: reportOf(1), lastRetroAt: T0 - 6 * HOUR, now: T0 });
	check("源2：边界含等号（age == interval → 到期）", rEdge.fire === true && rEdge.reason === "due");
	const rNotYet = evaluateRetroTrigger({ report: reportOf(1), lastRetroAt: T0 - (6 * HOUR - 1), now: T0 });
	check("源2：差 1ms 未到期 → 不燃（时钟注入：假钟拨出来的边界）",
		rNotYet.fire === false && rNotYet.reason === "none", JSON.stringify(rNotYet));
	// 时钟注入本尊：同一输入、两个 now → 结论翻转（钟不是写死的）
	const base = { report: reportOf(1), lastRetroAt: T0 - HOUR, intervalMs: 2 * HOUR };
	const atT0 = evaluateRetroTrigger({ ...base, now: T0 });
	const atT0plus2h = evaluateRetroTrigger({ ...base, now: T0 + 2 * HOUR });
	check("源2：时钟注入（同输入，now 拨过间隔线 → none 翻 due）",
		atT0.fire === false && atT0plus2h.fire === true && atT0plus2h.reason === "due",
		JSON.stringify([atT0, atT0plus2h]));
	const rIso = evaluateRetroTrigger({ report: reportOf(1), lastRetroAt: new Date(T0 - 6 * HOUR).toISOString(), now: T0 });
	check("源2：lastRetroAt 吃 ISO 字符串/Date 与 ms 同义",
		rIso.fire === true && rIso.reason === "due"
		&& evaluateRetroTrigger({ report: reportOf(1), lastRetroAt: new Date(T0 - 6 * HOUR), now: T0 }).reason === "due");
	const rFuture = evaluateRetroTrigger({ report: reportOf(1), lastRetroAt: T0 + HOUR, now: T0 });
	check("源2：挂钟在未来的历史（偏钟）不当到期", rFuture.fire === false && rFuture.reason === "none");
}

// ============ 3) 源3：收尾钩子（独立触发；加速器不是命脉） ============
{
	const r = evaluateRetroTrigger({ report: reportOf(1), lastRetroAt: T0 - HOUR, hookFired: true, now: T0 });
	check("源3：钩子事件在场 → fire reason=hook（热点未达阈、未到期也触发——独立源）",
		r.fire === true && r.reason === "hook", JSON.stringify(r));
	const r0 = evaluateRetroTrigger({ report: reportOf(0), lastRetroAt: T0 - HOUR, hookFired: true, now: T0 });
	check("源3：零热点+钩子也 fire（拉的是「扫一遍」，拉不拉分身由 retropad 零热点闸管）",
		r0.fire === true && r0.reason === "hook");
}

// ============ 4) 全不触发 + 判序 ============
{
	const r = evaluateRetroTrigger({ report: reportOf(2), lastRetroAt: T0 - HOUR, now: T0 });
	check("全不触发：热点 2<3、上次 1h<6h、无钩子 → fire=false reason=none（detail 报三源各自差多少）",
		r.fire === false && r.reason === "none" && /三源全不满足/.test(r.detail), JSON.stringify(r));
	const both = evaluateRetroTrigger({ report: reportOf(5), lastRetroAt: T0 - 6 * HOUR, now: T0 });
	check("判序：threshold+due 同燃 → reason=threshold（蓝图列序，最有信息量先报）",
		both.reason === "threshold");
	const dh = evaluateRetroTrigger({ report: reportOf(1), lastRetroAt: T0 - 6 * HOUR, hookFired: true, now: T0 });
	check("判序：due+hook 同燃 → reason=due", dh.reason === "due");
	let threwT = null, threwI = null;
	try { evaluateRetroTrigger({ threshold: 0 }); } catch (e) { threwT = e; }
	try { evaluateRetroTrigger({ intervalMs: -1 }); } catch (e) { threwI = e; }
	check("fail-load：阈值/间隔非法值构造即抛（纪律不是装饰）",
		threwT instanceof RangeError && threwI instanceof RangeError);
}

// ============ 5) 状态文件（源2的数据面：内嵌时间戳优先，mtime 兜底，无文件=无历史） ============
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retro-trigger-"));
	const sf = path.join(tmp, "state.json");
	check("状态：文件不存在 → 无历史（source=none → due 立即到期）",
		readRetroState(sf).lastRetroAt === null && readRetroState(sf).source === "none");
	const w = writeRetroState(sf, T0, { taskId: "retro-x", verdict: "nothing" });
	const r1 = readRetroState(sf);
	check("状态：写读回路（lastRetroAt=ms、runs 累计、extra 原样带回、source=json）",
		r1.lastRetroAt === T0 && r1.source === "json" && r1.raw.runs === 1 && r1.raw.verdict === "nothing",
		JSON.stringify(r1.raw));
	writeRetroState(sf, T0 + HOUR, {});
	const r2 = readRetroState(sf);
	check("状态：runs 逐场累计（第二场 runs=2，lastRetroAt 更新）",
		r2.lastRetroAt === T0 + HOUR && r2.raw.runs === 2);
	// 触发器与状态文件的真接线：刚写完的状态 → 未到期；mtime 兜底路径 → 坏 JSON 也能给「文件在」的时间
	const wired = evaluateRetroTrigger({ report: reportOf(1), lastRetroAt: readRetroState(sf).lastRetroAt, now: T0 + 90 * 60_000 });
	check("接线：readRetroState 喂 evaluateRetroTrigger（刚盘完 90min < 6h → 不燃）",
		wired.fire === false && wired.reason === "none");
	const mtimeBefore = Date.now();
	fs.writeFileSync(sf, "{ 半截 JSON（手改坏/瞬断写入）");
	const r3 = readRetroState(sf);
	check("状态：坏 JSON → mtime 兜底（文件在=盘过，时间看 mtime——不为半截文件假装无历史）",
		r3.source === "mtime" && r3.lastRetroAt != null && r3.lastRetroAt >= mtimeBefore - 2000, JSON.stringify(r3));
	let threwPath = null;
	try { readRetroState(""); } catch (e) { threwPath = e; }
	check("状态：空路径 fail-fast", threwPath != null);
	fs.rmSync(tmp, { recursive: true, force: true });
}

// ============ 6) 源3 回调注册位（钩子是加速器不是命脉：单个坏处理器不炸其余） ============
{
	const hook = createSessionEndHook();
	const seen = [];
	const off = hook.register((ev) => seen.push(["a", ev.sessionId]));
	hook.register((ev) => seen.push(["b", ev.sessionId]));
	const ev0 = { sessionId: "s-1" };
	const warn0 = [];
	const hook2 = createSessionEndHook({ onError: (err) => warn0.push(err.message) });
	hook2.register(() => { throw new Error("钩子里的坏形状"); });
	const ok2 = hook2.register((ev) => seen.push(["c", ev.sessionId]));
	const res = hook2.fire({ sessionId: "s-2" });
	check("钩子：fire 逐个调处理器（含事件透传）", seen.some((s) => s[0] === "c" && s[1] === "s-2"));
	check("钩子：单个处理器抛错 → 出声跳过，其余照跑（failed=1 fired=1——兜底常在，钩子不是命脉）",
		res.fired === 1 && res.failed === 1 && warn0.length === 1 && warn0[0].includes("坏形状"), JSON.stringify(res));
	hook.fire(ev0);
	check("钩子：登记即生效（a/b 都收到 s-1）", seen.filter((s) => s[1] === "s-1").length === 2);
	off();
	hook.fire({ sessionId: "s-3" });
	check("钩子：注销函数生效（s-3 只剩 b）", seen.filter((s) => s[1] === "s-3").length === 1 && hook.size() === 1);
	let threwFn = null;
	try { hook.register("不是函数"); } catch (e) { threwFn = e; }
	check("钩子：非函数登记 fail-fast（TypeError）", threwFn instanceof TypeError);
	// 钩子 → 触发器接线：钩子回调里把 hookFired 传进 evaluateRetroTrigger 是消费姿势（结构钉住）
	let fired = null;
	const hook3 = createSessionEndHook();
	hook3.register((ev) => { fired = evaluateRetroTrigger({ report: reportOf(1), lastRetroAt: T0 - HOUR, hookFired: true, now: T0 }); });
	hook3.fire({ sessionId: "s-9" });
	check("接线：钩子回调 → evaluateRetroTrigger(hookFired) → fire reason=hook",
		fired?.fire === true && fired?.reason === "hook");
}

console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
