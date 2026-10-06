/**
 * ledger.mjs — spawn 台账（任务编排器⑧ 施工铲3，蓝图 §4.1 状态面）
 *
 * 常驻数据结构（不是每次翻遥测+会话文件拼——那是手工版的烦，机械化的便利）。
 * 每行：分身id、角色、哪张任务书、何时起、最后心跳、累计花费、当前状态（跑/等审/收/死）。
 * 「一键拉全部分身实时状态」= print()。
 * 心跳 = 遥测事件的机械登记（registerHeartbeat 被动收，编排器不轮询分身）。
 */

export const LEDGER_STATUSES = ["跑", "等审", "收", "死"];
export const IN_FLIGHT_STATUSES = ["跑", "等审"];

export class SpawnLedger {
	constructor() {
		this.rows = new Map(); // id → row（保插入序）
	}

	/** 登记一个分身上场。重复 id 拒绝（台账按进程记，id 即身份）。 */
	register({ id, role, sheetId, sandboxTier = null, pointer = null, startedAt = Date.now() }) {
		if (this.rows.has(id)) throw new Error(`台账重复 id：${id}`);
		const row = {
			id, role, sheetId, sandboxTier, pointer,
			startedAt, lastHeartbeat: null, lastEventKind: null,
			cost: 0, status: "跑", reportMode: false, note: null,
		};
		this.rows.set(id, row);
		return { ...row };
	}

	/**
	 * 心跳登记：编排器收遥测事件时被动调用（不轮询）。
	 * @returns 更新后的行；未知 id → { ok:false }（死行/未登记不炸，出声即可）
	 */
	registerHeartbeat(id, event = {}) {
		const row = this.rows.get(id);
		if (!row) return { ok: false, error: `未知分身：${id}` };
		if (event.ts != null) row.lastHeartbeat = event.ts;
		if (event.kind != null) row.lastEventKind = event.kind;
		if (event.tool != null) row.lastTool = event.tool;
		return { ok: true, row: this.get(id) };
	}

	addCost(id, amount) {
		const row = this.rows.get(id);
		if (!row) return { ok: false, error: `未知分身：${id}` };
		row.cost += amount;
		return { ok: true, row: this.get(id) };
	}

	/** 状态迁移：跑/等审/收/死。非法状态拒绝（台账不说黑话）。 */
	setStatus(id, status, note = null) {
		if (!LEDGER_STATUSES.includes(status)) throw new Error(`台账非法状态：${status}`);
		const row = this.rows.get(id);
		if (!row) return { ok: false, error: `未知分身：${id}` };
		row.status = status;
		if (note != null) row.note = note;
		return { ok: true, row: this.get(id) };
	}

	get(id) {
		const row = this.rows.get(id);
		return row ? { ...row } : null;
	}

	all() {
		return [...this.rows.values()].map((r) => ({ ...r }));
	}

	/** 在飞 = 跑 + 等审（收/死已下场） */
	inFlight() {
		return this.all().filter((r) => IN_FLIGHT_STATUSES.includes(r.status));
	}

	/** 一键拉全部分身实时状态：人话表格，在飞行必含。 */
	print({ now = null } = {}) {
		const head = `== spawn 台账（共 ${this.rows.size} 行，在飞 ${this.inFlight().length}）==`;
		const lines = this.all().map((r) => {
			const beat = r.lastHeartbeat ?? "无";
			const age = now != null && r.lastHeartbeat != null ? ` 心跳龄=${Math.max(0, Math.round((now - Date.parse(r.lastHeartbeat)) / 1000))}s` : "";
			return `[${r.id}] 角色=${r.role} 书=${r.sheetId} 状态=${r.status}${r.reportMode ? "(报告模式)" : ""} 起=${new Date(r.startedAt).toISOString()} 心跳=${beat}${age} 花费=${r.cost}${r.note ? ` 注=${r.note}` : ""}`;
		});
		return [head, ...lines].join("\n");
	}
}
