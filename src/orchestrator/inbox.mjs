/**
 * inbox.mjs — 前台收件箱（任务编排器⑧ 施工铲8，蓝图 §4.5）
 *
 * FIFO 语义：新上下文不打断旧回复——回复完成后才推。
 * v0 只做队列本身：「送达时机不打断旧回复」的推送语义归会话编排层（§10），这里不碰。
 *
 * 四类送达物（蓝图 §4.5 + the user 10/7 定案①拍板7）：
 *   交货单（完成）/ 讣告（死亡）/ 通知（并发撞限等非死亡异常）/ 审批（分身上浮的 pending 审批卡）
 * 收件箱只是送达，终审权在前台（§7 信任边界不进本铲）。
 */

export const INBOX_KINDS = ["交货单", "讣告", "通知", "审批"];

export class Inbox {
	constructor() {
		this.items = [];
		this.seq = 0;
	}

	/** 送达：FIFO 入队。非法类型拒绝（送达物类型是收件箱的词法，不收黑话）。 */
	deliver(kind, payload = {}) {
		if (!INBOX_KINDS.includes(kind)) {
			throw new Error(`收件箱非法送达物类型：${kind}（合法：${INBOX_KINDS.join("/")}）`);
		}
		const item = { seq: ++this.seq, kind, enqueuedAt: Date.now(), payload };
		this.items.push(item);
		return item;
	}

	/** 读取：FIFO 先进先出，读走即出队。空箱 → null。 */
	read() {
		return this.items.length ? this.items.shift() : null;
	}

	/** 看队头不出队 */
	peek() {
		return this.items[0] ?? null;
	}

	size() {
		return this.items.length;
	}

	/** 只看不取（盯场用） */
	peekAll() {
		return this.items.map((i) => ({ ...i }));
	}
}
