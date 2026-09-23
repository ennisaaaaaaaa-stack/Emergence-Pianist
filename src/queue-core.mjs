/**
 * queue-core.mjs — 审批队列 + 写队列（施工④壳骨架 v1，2026-09-24）
 *
 * 铁律继承：壳永不直接调 LLM API——「自然语言描述」是规则模板+调用方自述，
 * 不烧 token；要更细的意图解释属于 ⑥（spawn 真 Pi 进程）的活。
 *
 * 1. 审批队列（人类视线三层，甜心 9/23）：
 *    red（必问：挂起等人类批准，不批不动）/ amber（通知：立即执行，留人类可读通知）
 *    / 其余（静默放行）。决定权只在人类 HTTP 侧——bridge 只给查询面，不给批准面。
 * 2. 写队列（铁律4「并发写走壳层写队列；别让慢的堵快的」）：
 *    同 key 串行、异 key 并行。
 *
 * 设计依据：arch-v2 铁律节 / pianist-runtime-dependency-map v4 待办 / 甜心 9/23 桌面端决策
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// 风险分层
// ---------------------------------------------------------------------------

/** bash 红区：不可逆破坏或全盘级操作（数组归一，「或」语义） */
const BASH_RED_RES = [
	/\brm\s+-[a-zA-Z]*r/, // 递归删除
	/\brm\s+-[a-zA-Z]*f\b(?![a-zA-Z]*r)/, // 强删（单独 -f 也算：绕过确认的删除）
	/\bdd\s+of=/, // 裸写块设备
	/\bmkfs\b/, // 格式化
	/:\s*\(\)\s*\{.*\}\s*;\s*:/, // fork bomb
	/\bchmod\s+-R\s+777\s+\//, // 全盘放开权限
	/>\s*\/dev\/sd[a-z]/, // 直写磁盘设备
	/\bgit\s+push\s+--force\b/, // 改写远端历史
	/\bgit\s+reset\s+--hard\b/, // 丢弃工作区改动
];

/** bash 灰区：可逆但影响仓库/系统状态的常见写 */
const BASH_AMBER_RES = [
	/\bgit\s+(push|commit|reset|checkout\s+--|clean|rebase|merge|cherry-pick|revert|stash\s+drop)\b/,
	/\bnpm\s+(install|i|update|uninstall|ci)\b/,
	/\b(pip|pip3)\s+install\b/,
	/\bcurl\b[^\n]*\|\s*(ba)?sh/,
	/\bwget\b[^\n]*\|\s*(ba)?sh/,
	/\bsudo\b/,
	/\bsystemctl\s+(start|stop|restart|disable|enable)\b/,
	/\b(kill|killall|pkill)\b/,
	/\b(scp|rsync)\b/,
];

/** 工具级风险表：在表 = 写操作（进写队列），值 = 视线层 */
const ACTION_RISK = {
	// Grimoire 写面
	grimoire_submit: "red", // 投山海 = 进公开库的写
	grimoire_event: "amber", // 记事件 = 本地账本追加
	// spoor 工作台写面
	spoor_journal: "amber",
	spoor_snippet: "amber",
	spoor_status: "amber",
	// spoor 档案房写面（append-only 家底）
	spoor_archive_put: "red",
	spoor_archive_pin: "red",
	spoor_archive_unpin: "red",
	spoor_archive_link: "red",
	// spoor 涂鸦房写面
	spoor_scratch_create: "amber",
	spoor_scratch_write: "amber",
};

/** 分层判定：red / amber / silent */
export function classify(action, payload) {
	if (action === "bash") {
		const cmd = String(payload?.command ?? "");
		if (BASH_RED_RES.some((re) => re.test(cmd))) return "red";
		if (BASH_AMBER_RES.some((re) => re.test(cmd))) return "amber";
		return "silent";
	}
	return ACTION_RISK[action] ?? "silent";
}

// ---------------------------------------------------------------------------
// 自然语言层（甜心 9/23：审批要说人话，黑话用户看不懂）
// ---------------------------------------------------------------------------

const ACTION_HUMAN = {
	grimoire_submit: "往山海提交一本新 skill 书",
	grimoire_event: "往山海事件账本追加一条记录",
	spoor_journal: "往猎迹工作台追加一条工作记录",
	spoor_snippet: "在猎迹工作台存一段复用代码",
	spoor_status: "刷新猎迹项目的进行中状态板",
	spoor_scratch_create: "创建一间临时涂鸦房",
	spoor_scratch_write: "往涂鸦房写文件",
	spoor_archive_put: "往档案房归档一个新版本",
	spoor_archive_pin: "把档案的默认版本钉到指定版本",
	spoor_archive_unpin: "撤销档案的版本钉子",
	spoor_archive_link: "给档案版本建一个外部指针",
};

const ACTION_IMPACT = {
	grimoire_submit: "写进公开库的待审区——审核通过前不生效，可撤回",
	grimoire_event: "只追加一条记录，不改动已有内容",
	spoor_journal: "只追加一条记录，不改动已有内容",
	spoor_snippet: "覆盖同名复用件（不传内容则是读取）",
	spoor_status: "覆盖该项目的状态板全文",
	spoor_scratch_create: "新增一个临时空间（清理时整体丢弃）",
	spoor_scratch_write: "写入临时文件（覆盖或追加）",
	spoor_archive_put: "档案房 append-only：只新增版本，不动旧版本",
	spoor_archive_pin: "改变后续默认读取指向，账本会记一笔",
	spoor_archive_unpin: "默认读取回到最新版本，账本会记一笔",
	spoor_archive_link: "只加指针不搬内容，账本会记一笔",
};

const BASH_HUMAN = {
	git: "运行 git 版本控制命令",
	npm: "运行 npm 包管理命令",
	npx: "运行一个 npm 包里的命令",
	pip: "安装/管理 Python 包",
	curl: "发送网络请求",
	wget: "下载文件",
	sudo: "以管理员权限执行命令",
	rm: "删除文件",
	mv: "移动或重命名文件",
	cp: "复制文件",
	mkdir: "创建目录",
	chmod: "修改文件权限",
	kill: "终止进程",
	scp: "在机器之间拷贝文件",
	ssh: "连接远程机器",
	systemctl: "管理系统服务",
};

function bashHuman(cmd) {
	const c = String(cmd ?? "").trim();
	const first = c.split(/\s+/)[0] ?? "";
	return BASH_HUMAN[first] ?? `执行 shell 命令：${c.slice(0, 80)}`;
}

/** 人话动作描述。intent 是调用方自述（agent 填的「我在干嘛」），有则前置 */
export function describe(action, payload, intent) {
	const what = action === "bash" ? bashHuman(payload?.command) : (ACTION_HUMAN[action] ?? `调用 ${action}`);
	const who = typeof intent === "string" && intent.trim() ? `（自述：${intent.trim().slice(0, 120)}）` : "";
	return `${what}${who}`;
}

/** 影响说明（卡片第二行）*/
export function impactOf(action, payload) {
	if (action === "bash") {
		const cmd = String(payload?.command ?? "");
		if (/\brm\b/.test(cmd)) return "删除操作——删了就没了";
		if (/\bgit\s+push/.test(cmd)) return "推到远端仓库——别人能看到/拉到";
		if (/--force|--hard/.test(cmd)) return "改写/丢弃历史——找回成本高";
		return "会改动这台机器上的东西";
	}
	return ACTION_IMPACT[action] ?? "本地服务调用，不直接改动文件";
}

// ---------------------------------------------------------------------------
// 审批队列（红区挂起等人类；决定权只在 HTTP 侧，bridge 无批准面）
// ---------------------------------------------------------------------------

let approvalSeq = 0;

export class ApprovalQueue {
	/** @param {string|null} auditFile 审计 JSONL 路径（null=不落盘，测试用） */
	constructor(auditFile = null) {
		this.items = new Map(); // id → item
		this.auditFile = auditFile;
	}

	/** 红区请求入队。返回完整卡片（pending 态） */
	request(action, payload, agent, intent) {
		const id = `ap_${Date.now().toString(36)}_${++approvalSeq}`;
		const item = {
			id,
			action,
			agent: agent ?? "unknown",
			summary: describe(action, payload, intent),
			impact: impactOf(action, payload),
			raw: { action, payload: payload ?? null },
			status: "pending", // pending | executed | denied
			createdAt: new Date().toISOString(),
			decidedAt: null,
			decidedBy: null,
			note: null,
			result: null,
		};
		this.items.set(id, item);
		return item;
	}

	pending() {
		return [...this.items.values()].filter((i) => i.status === "pending");
	}

	get(id) {
		return this.items.get(id) ?? null;
	}

	/** 人类裁决。approve=true 时由调用方负责执行并回填 result。幂等冲突返回 null。 */
	decide(id, approve, by, note) {
		const item = this.items.get(id);
		if (!item || item.status !== "pending") return null;
		item.status = approve ? "executed" : "denied";
		item.decidedAt = new Date().toISOString();
		item.decidedBy = by ?? "human";
		item.note = note ?? null;
		this.audit({
			id,
			action: item.action,
			agent: item.agent,
			approve,
			by: item.decidedBy,
			note: item.note,
			ts: item.decidedAt,
		});
		return item;
	}

	/** 自动放行（APPROVAL_MODE=auto 时的红区）也记审计——暗区不许无痕 */
	auditAuto(item, auto) {
		this.audit({ id: item.id, action: item.action, agent: item.agent, approve: true, by: `auto:${auto}`, ts: new Date().toISOString() });
	}

	audit(line) {
		if (!this.auditFile) return;
		try {
			fs.mkdirSync(path.dirname(this.auditFile), { recursive: true });
			fs.appendFileSync(this.auditFile, JSON.stringify({ v: 1, ...line }) + "\n");
		} catch {
			// 审计落盘失败不阻塞裁决——但必须出声
			console.warn(`[approval] 审计落盘失败：${JSON.stringify(line).slice(0, 200)}`);
		}
	}
}

// ---------------------------------------------------------------------------
// 写队列（铁律4：同 key 串行、异 key 并行）
// ---------------------------------------------------------------------------

export class WriteQueue {
	constructor() {
		this.chains = new Map(); // key → 尾部 promise
		this.sizes = new Map(); // key → 在途数（stats 用）
	}

	/** 同 key 排队执行；fn 抛错不污染链（下一棒照跑） */
	run(key, fn) {
		const prev = this.chains.get(key) ?? Promise.resolve();
		const size = (this.sizes.get(key) ?? 0) + 1;
		this.sizes.set(key, size);
		const next = prev
			.catch(() => {}) // 前棒失败不拦后棒
			.then(() => fn())
			.finally(() => {
				const s = (this.sizes.get(key) ?? 1) - 1;
				if (s <= 0) this.sizes.delete(key);
				else this.sizes.set(key, s);
				// 链尾回收：没有后来者时清引用，防泄漏
				if (this.chains.get(key) === next) this.chains.delete(key);
			});
		this.chains.set(key, next);
		return next;
	}

	stats() {
		return Object.fromEntries(this.sizes);
	}
}

// ---------------------------------------------------------------------------
// 通知环（灰区：执行后留一条人类可读通知）
// ---------------------------------------------------------------------------

export class NotifyRing {
	constructor(cap = 200) {
		this.cap = cap;
		this.items = [];
		this.seq = 0;
	}

	push(action, payload, agent, intent) {
		const n = {
			id: `nt_${Date.now().toString(36)}_${++this.seq}`,
			ts: new Date().toISOString(),
			agent: agent ?? "unknown",
			summary: describe(action, payload, intent),
			impact: impactOf(action, payload),
		};
		this.items.push(n);
		if (this.items.length > this.cap) this.items.splice(0, this.items.length - this.cap);
		return n;
	}

	since(lastId, limit = 50) {
		let start = 0;
		if (lastId) {
			const idx = this.items.findIndex((n) => n.id === lastId);
			start = idx >= 0 ? idx + 1 : 0; // 不认识的 id 从头给（桌面端重置场景）
		}
		return this.items.slice(start, start + limit);
	}
}
