/**
 * watchman.mjs — 生命周期看门人（任务编排器⑧ 第二铲；蓝图 EP-Orchestrator.md §4.5/§6/§10，拍板表⑧-2 #4）
 *
 * 是什么：常驻循环里的扫尸哨。sweep() 三判——「台账行状态=跑 × 心跳超静默窗 ×
 * driver.isAlive=false」→ 收件箱推「讣告候选」事件。
 *
 * 看门人只喊，法医才开死亡证明（拍板 #4 的原话）：
 *   - 看门人**不入账**（台账行一个字不动）、**不定死因**（不开讣告）、**不杀进程**——
 *     只把「死透了」的形状报给收件箱；session_death 的裁定归引擎/主agent 按失败语义
 *     表（§6 行6）走。蓝图 §10「会话编排不持任务语义」的边界照住：看门同样不持。
 *   - 送达物=事件**指针**不是现场：附台账行指针（minionId/sheetId/状态）+最后心跳
 *     时刻+静默时长——不内联台账全文/遥测/会话原文，验尸三源由法医按需取（obituary 的事）。
 *
 * 阴性纪律（灵魂——还在干活不算死，静默钟才是它的医生，看门只管「死透了」形状）：
 *   - 心跳活着（最后心跳在静默窗内）→ 不喊（哪怕探活说进程不在——刚退场收尾泵在路上）；
 *   - 进程活着（isAlive=true/未知）心跳停 → 不喊（卡在慢工具里不是死，那是静默钟的活）；
 *   - 状态不在「跑」（等审归审链、收/死已下场）→ 不喊。
 *
 * 幂等：同一 minion 只喊一次（喊过就记名——收件箱不被同一具尸体刷屏）。
 *
 * 收件箱词法纪律：Inbox 只认 交货单/讣告/通知 三类（inbox.mjs 本单不动）——
 * 讣告候选以「通知」送达、payload.kind="讣告候选" 点名事件身份（它还没死透到能开讣告）。
 *
 * 纯逻辑零 spawn：ledger/inbox/driver 全注入（测试用假驱动器），时钟注入（假时钟可测）。
 */

export class Watchman {
	/**
	 * @param {object} opts
	 * @param {object} opts.ledger          spawn 台账（只用 all() 读行）
	 * @param {object} opts.inbox           前台收件箱（deliver 通知）
	 * @param {object} opts.driver          驱动器接口（只用 isAlive 探活）
	 * @param {Function} [opts.now]         时钟注入（缺省 Date.now；测试假时钟）
	 * @param {number} [opts.silentWindowMs] 静默窗（最后心跳距今超过它才算「静默」；缺省 60s）
	 */
	constructor({ ledger, inbox, driver, now = Date.now, silentWindowMs = 60_000 } = {}) {
		if (!ledger || !inbox || !driver) throw new Error("Watchman 需要 ledger/inbox/driver（三判的三个证人缺一不可）");
		this.ledger = ledger;
		this.inbox = inbox;
		this.driver = driver;
		this.now = now;
		this.silentWindowMs = silentWindowMs;
		this.shouted = new Set(); // minionId → 已喊（幂等：同一分身只喊一次）
	}

	shoutedFor(minionId) {
		return this.shouted.has(minionId);
	}

	/** 静默基点：最后心跳时刻；从没跳过的心脏按发车时刻起算（无心跳也算静默——静默钟同族语义）。 */
	_silentSince(row) {
		const ms = row?.lastHeartbeat != null ? Date.parse(row.lastHeartbeat) : NaN;
		return Number.isFinite(ms) ? ms : (row?.startedAt ?? 0);
	}

	/**
	 * 扫一轮。三判全中才喊，喊完记名（幂等）。
	 * @param {number} [nowMs] 缺省 now()（生产=真时钟；测试=假时钟注入）
	 * @returns {Array<{minionId: string, item: object}>} 本轮喊出的讣告候选（空数组=没人死透）
	 */
	sweep(nowMs = this.now()) {
		const out = [];
		for (const row of this.ledger.all()) {
			if (row.status !== "跑") continue;                  // 判①：只在飞「跑」行喊（等审归审链，收/死已下场）
			if (this.shouted.has(row.id)) continue;            // 幂等：喊过的不二喊
			if (this.driver.isAlive(row.id) !== false) continue; // 判③：探活不回「死透了」就不喊（活着/未知都闭嘴）
			const silentMs = nowMs - this._silentSince(row);
			if (silentMs < this.silentWindowMs) continue;      // 判②：静默不够久不喊（刚死/刚发车都不算）
			const item = this.inbox.deliver("通知", {
				kind: "讣告候选",
				reason: "看门人三判全中（状态=跑 × 心跳超静默窗 × 进程不在）——只喊不定死，session_death 裁定归引擎/主agent（失败语义表行6）",
				minionId: row.id,
				ledgerPointer: { minionId: row.id, sheetId: row.sheetId, status: row.status }, // 指针不内联现场
				lastHeartbeat: row.lastHeartbeat ?? null,
				silentMs,
				silentWindowMs: this.silentWindowMs,
				observedAt: new Date(nowMs).toISOString(),
			});
			this.shouted.add(row.id);
			out.push({ minionId: row.id, item });
		}
		return out;
	}
}
