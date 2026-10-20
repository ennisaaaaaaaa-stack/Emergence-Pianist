/**
 * inbox.mjs — 前台收件箱（任务编排器⑧ 施工铲8，蓝图 §4.5）
 *
 * FIFO 语义：新上下文不打断旧回复——回复完成后才推。
 * v0 只做队列本身：「送达时机不打断旧回复」的推送语义归会话编排层（§10），这里不碰。
 *
 * 四类送达物（蓝图 §4.5 + the user 10/7 定案①拍板7）：
 *   交货单（完成）/ 讣告（死亡）/ 通知（并发撞限等非死亡异常）/ 审批（分身上浮的 pending 审批卡）
 * 收件箱只是送达，终审权在前台（§7 信任边界不进本铲）。
 *
 * F2 收件箱按天清（docs/f2-inbox-ttl-spec-v0.2.1.md）：deliver() 自动打 day（nowJstDay 同源真钟，
 * 构造器可注钟——写入与清理同一座钟，spec「钟屋」节）；sweepExpired() 把 day < today 的条目
 * 出队（删除不转储、不回补）。无 day 的存量条目不按 today fallback（施工读法 A 禁 B，hui #1088）
 * ——存量走上线迁移（tools/migrate-inbox-day.mjs，壳审批卡面）。
 */

import { nowJstDay } from "./day-clock.mjs";
import { ttlExpired } from "../inbox-ttl.mjs";

export const INBOX_KINDS = ["交货单", "讣告", "通知", "审批"];

export class Inbox {
	/** @param {{now?: () => number}} [opts] 时钟注入位（缺省真钟 Date.now——day 打点与 enqueuedAt 与清理判定共用它） */
	constructor({ now = () => Date.now() } = {}) {
		this.items = [];
		this.seq = 0;
		this._now = now;
	}

	/** 送达：FIFO 入队。非法类型拒绝（送达物类型是收件箱的词法，不收黑话）。day=落账日 JST 日（F2）。 */
	deliver(kind, payload = {}) {
		if (!INBOX_KINDS.includes(kind)) {
			throw new Error(`收件箱非法送达物类型：${kind}（合法：${INBOX_KINDS.join("/")}）`);
		}
		const item = { seq: ++this.seq, kind, day: nowJstDay(this._now()), enqueuedAt: this._now(), payload };
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

	/** F2 按天清（spec 语义 1/2）：过期条目出队——删除不转储、不触发任何补发/重派（语义 3 帷幕线）。
	 *  返回清理清单 [{ id, seq, kind, day }] 供记账行（inbox-ttl.mjs sweepAccountLine）。
	 *  now=判定钟（缺省本箱注入钟/真钟——与 deliver 打 day 同源，验收 6）；mode 逃生门（缺省 day 正典）。
	 *  无 day 的存量条目不按 today 计（施工读法 A 禁 B——B 读法下存量永生，hui #1088）。 */
	sweepExpired(now = this._now(), mode = "day") {
		const expired = [];
		const kept = [];
		for (const item of this.items) {
			if (ttlExpired(mode, { day: item.day, atMs: item.enqueuedAt, kind: item.kind }, now)) {
				expired.push({ id: `#${item.seq}`, seq: item.seq, kind: item.kind, day: item.day ?? null }); // id 记账形状：#seq（与审批单号 ap_* 同场可读）
			} else {
				kept.push(item);
			}
		}
		this.items = kept;
		return expired;
	}

	/** 只看不取（盯场用）。v0.2（10/16 审链裁决）：在保留 payload 的基础上**平铺**常用字段（minionId/taskId/manifest/text）
	 *  ——新消费方直接取顶层字段，老消费方（orch-real-driver-test 的 o.payload.cause）继续可用。双轨兼容。 */
	peekAll() {
		return this.items.map(({ kind, payload, ...rest }) => ({
			kind, payload, ...rest,
			minionId: payload?.minionId, taskId: payload?.taskId,
			manifest: payload?.manifest, text: payload?.text,
		}));
	}
}
