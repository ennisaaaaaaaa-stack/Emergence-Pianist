/**
 * queue-core.mjs — 审批队列 + 写队列（施工④壳骨架 v1，2026-09-24）
 *
 * 铁律继承：壳永不直接调 LLM API——「自然语言描述」是规则模板+调用方自述，
 * 不烧 token；要更细的意图解释属于 ⑥（spawn 真 Pi 进程）的活。
 *
 * 1. 审批队列（人类视线三层，the user 9/23）：
 *    red（必问：挂起等人类批准，不批不动）/ amber（通知：立即执行，留人类可读通知）
 *    / 其余（静默放行）。决定权只在人类 HTTP 侧——bridge 只给查询面，不给批准面。
 * 2. 写队列（铁律4「并发写走壳层写队列；别让慢的堵快的」）：
 *    同 key 串行、异 key 并行。
 *
 * 设计依据：arch-v2 铁律节 / pianist-runtime-dependency-map v4 待办 / the user 9/23 桌面端决策
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isAutoSubmission, validateSkillSubmission } from "./skill-gate.mjs";

// ---------------------------------------------------------------------------
// 风险分层
// ---------------------------------------------------------------------------

/** bash 红区：不可逆破坏或全盘级操作（数组归一，「或」语义）。
 *  形状 {re, name}：name 是规则中文名，供机器行「[红区] 规则名」用（the user 10/7 定案②拍板8）。
 *  导出 = 单一事实源：分身 extension 侧红区判定 import 这份，不抄第二份正则（定案①拍板4） */
export const BASH_RED_RES = [
	{ re: /\brm\s+-[a-zA-Z]*r/, name: "递归删除" },
	{ re: /\brm\s+-[a-zA-Z]*f\b(?![a-zA-Z]*r)/, name: "强删（绕过确认）" },
	{ re: /\bdd\s+of=/, name: "裸写块设备" },
	{ re: /\bmkfs\b/, name: "格式化" },
	{ re: /:\s*\(\)\s*\{.*\}\s*;\s*:/, name: "fork 炸弹" },
	{ re: /\bchmod\s+-R\s+777\s+\//, name: "全盘放开权限" },
	{ re: />\s*\/dev\/sd[a-z]/, name: "直写磁盘设备" },
	{ re: /\bgit\s+push\s+--force\b/, name: "改写远端历史" },
	{ re: /\bgit\s+reset\s+--hard\b/, name: "丢弃工作区改动" },
];

/** bash 灰区：可逆但影响仓库/系统状态的常见写（name 同红区——机器行灰区也给规则名） */
const BASH_AMBER_RES = [
	{ re: /\bgit\s+(push|commit|reset|checkout\s+--|clean|rebase|merge|cherry-pick|revert|stash\s+drop)\b/, name: "git 写操作" },
	{ re: /\bnpm\s+(install|i|update|uninstall|ci)\b/, name: "npm 包写操作" },
	{ re: /\b(pip|pip3)\s+install\b/, name: "pip 安装" },
	{ re: /\bcurl\b[^\n]*\|\s*(ba)?sh/, name: "curl 管道执行" },
	{ re: /\bwget\b[^\n]*\|\s*(ba)?sh/, name: "wget 管道执行" },
	{ re: /\bsudo\b/, name: "sudo 提权" },
	{ re: /\bsystemctl\s+(start|stop|restart|disable|enable)\b/, name: "systemctl 服务操作" },
	{ re: /\b(kill|killall|pkill)\b/, name: "终止进程" },
	{ re: /\b(scp|rsync)\b/, name: "scp/rsync 远程拷贝" },
];

/** 沙箱内红区（施工⑤第二铲）：逃逸尝试 + 云 metadata 探测——零凭证铁律的防线位。
 *  容器档加固（cap-drop ALL 等）挡执行面，这层挡视线面：冲着逃逸/摸凭证去的命令不许混过 amber */
const SANDBOX_RED_RES = [
	/169\.254\.169\.254/, // 云 metadata 端点——沙箱内不该有任何凭证可摸
	/docker\.sock/, // 宿主 docker 套接字（挂载逃逸向量）
	/\bnsenter\b/, // 挤进宿主命名空间
	/>\s*\/proc\/sys\//, // 直写内核参数
];

/** 工具级风险表：在表 = 写操作（进写队列），值 = 视线层 */
const ACTION_RISK = {
	// Grimoire 写面
	grimoire_submit: "red", // 投Grimoire = 进公开库的写
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
	// 沙箱（施工⑤第二铲，分层初值the author拍板——命令深判见 classify，有异议以拍板为准不自行放宽）
	sandbox_execute: "amber", // 起容器跑命令 = 资源动作，串行+通知（临时工语义，不挂审批）
	sandbox_create_session: "amber", // 起容器
	sandbox_run_in_session: "amber", // 跑命令（载荷深判可上浮 red）
	sandbox_close: "amber", // 关全部会话
	sandbox_close_session: "silent", // 清扫面
	sandbox_is_alive: "silent", // 读面
	sandbox_read_file: "silent", // 沙箱内文件面——隔离环境内读写不碰宿主
	sandbox_write_file: "silent",
	sandbox_upload: "silent",
	// 认领报备（T3）：报备是出声动作不是写动作——不进审批、不进写队列，只进通知环
	notify_claim: "silent",
};

/** 分层判定：red / amber / silent */
export function classify(action, payload) {
	if (action === "bash") {
		const cmd = String(payload?.command ?? "");
		if (BASH_RED_RES.some((r) => r.re.test(cmd))) return "red";
		if (BASH_AMBER_RES.some((r) => r.re.test(cmd))) return "amber";
		return "silent";
	}
	// 自学习闭环 v2 第一铲：auto/ 提交过壳侧 skill-gate 四道闸 → 降 amber（通知不阻塞）。
	// ⚠️ 双条件堵伪造：_gate_pass 只能由壳侧校验通过后注入（shell.mjs queuedInvoke），
	// 单认 _gate_pass 不作数——classify 内对 payload 重跑 validateSkillSubmission 二次验证
	// （纯函数无副作用，机械校验零 LLM，代价可忽略）。其余 grimoire_submit 维持 red。
	if (action === "grimoire_submit"
		&& isAutoSubmission(payload)
		&& payload?._gate_pass === true
		&& validateSkillSubmission(payload).ok) {
		return "amber";
	}
	// 沙箱命令面深判（施工⑤第二铲）：载荷拆出 command 复用 bash 红灰区正则——
	// session 内 rm -rf / 逃逸尝试 / 云 metadata 仍挂审批（沙箱高危不减视线）；
	// 例外：npm install/curl 等下载在容器内是正常工作流 → 维持 amber 不上浮 red
	if (action === "sandbox_run_in_session" || action === "sandbox_execute") {
		const cmd = String(payload?.command ?? "");
		if (BASH_RED_RES.some((r) => r.re.test(cmd)) || SANDBOX_RED_RES.some((re) => re.test(cmd))) return "red";
		if (BASH_AMBER_RES.some((r) => r.re.test(cmd))) return "amber";
	}
	return ACTION_RISK[action] ?? "silent";
}

// ---------------------------------------------------------------------------
// 自然语言层（the user 9/23：审批要说人话，黑话用户看不懂）
// ---------------------------------------------------------------------------

const ACTION_HUMAN = {
	grimoire_submit: "往Grimoire提交一本新 skill 书",
	grimoire_event: "往Grimoire事件账本追加一条记录",
	spoor_journal: "往猎迹工作台追加一条工作记录",
	spoor_snippet: "在猎迹工作台存一段复用代码",
	spoor_status: "刷新猎迹项目的进行中状态板",
	spoor_scratch_create: "创建一间临时涂鸦房",
	spoor_scratch_write: "往涂鸦房写文件",
	spoor_archive_put: "往档案房归档一个新版本",
	spoor_archive_pin: "把档案的默认版本钉到指定版本",
	spoor_archive_unpin: "撤销档案的版本钉子",
	spoor_archive_link: "给档案版本建一个外部指针",
	// 沙箱（施工⑤第二铲）——命令面动作的 describe 会前置命令原文，见 describe()
	sandbox_execute: "在一次性沙箱容器里跑命令",
	sandbox_create_session: "开一间沙箱会话（新起一个隔离容器）",
	sandbox_run_in_session: "在沙箱会话里跑命令",
	sandbox_close: "关掉全部沙箱会话",
	sandbox_close_session: "关掉一间沙箱会话",
	sandbox_is_alive: "探一下沙箱会话是否还活着",
	sandbox_read_file: "读沙箱容器里的文件",
	sandbox_write_file: "往沙箱容器里写文件",
	sandbox_upload: "往沙箱容器批量上传文件",
	// 认领报备（T3）
	notify_claim: "分身认领报备",
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
	// 沙箱（施工⑤第二铲）
	sandbox_execute: "起临时容器跑完即清，不碰宿主文件",
	sandbox_create_session: "新起一个隔离容器（内存/CPU/进程数有上限，无端口映射）",
	sandbox_run_in_session: "只在隔离容器内生效，宿主不受影响",
	sandbox_close: "清扫全部沙箱容器，容器内文件一并丢弃",
	sandbox_close_session: "清扫对应容器，容器内文件一并丢弃",
	sandbox_is_alive: "只查状态，无副作用",
	sandbox_read_file: "只读沙箱内文件，不碰宿主",
	sandbox_write_file: "只写沙箱内文件，不碰宿主",
	sandbox_upload: "只写沙箱内文件，不碰宿主",
	notify_claim: "只进通知环报备一声，不写任何东西",
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
	let what;
	if (action === "bash") {
		what = bashHuman(payload?.command);
	} else if (action === "sandbox_run_in_session" || action === "sandbox_execute") {
		// 沙箱命令面：人话动作 + 命令原文——审批卡片必须看得到到底要跑什么
		const cmd = String(payload?.command ?? "").trim();
		what = `${ACTION_HUMAN[action] ?? "在沙箱里跑命令"}${cmd ? `：${cmd.slice(0, 80)}` : ""}`;
	} else {
		what = ACTION_HUMAN[action] ?? `调用 ${action}`;
	}
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
	if (action === "sandbox_run_in_session" || action === "sandbox_execute") {
		// 沙箱命令面：红区命令给防线位人话，删除给容器边界人话
		const cmd = String(payload?.command ?? "");
		if (SANDBOX_RED_RES.some((re) => re.test(cmd))) return "高危命令（逃逸/摸凭证形状）——就算在隔离容器里也要人类点头";
		if (/\brm\b/.test(cmd)) return "沙箱内删除——删了容器里就没了，宿主不受影响";
		return ACTION_IMPACT[action] ?? "只在隔离容器内生效，宿主不受影响";
	}
	return ACTION_IMPACT[action] ?? "本地服务调用，不直接改动文件";
}

// ---------------------------------------------------------------------------
// 审批卡片双行 + 命令指纹（the user 10/7 定案①②：机器行+白话行强制带，壳侧生成，不采信调用方自报）
// ---------------------------------------------------------------------------

/** commandHash：命令指纹（sha256 前 16 hex）。已批单次放行的匹配键（拍板5）——
 *  extension 与壳 import 同款函数计算，两侧必然一致 */
export function commandHash(command) {
	return crypto.createHash("sha256").update(String(command), "utf8").digest("hex").slice(0, 16);
}

/** 机器行：`[红区|灰区] 规则名`（拍板8）。bash 逐条规则取名；非 bash 动作用动作名本身当规则名。
 *  命中不了（白卡）→ 抛错：入队方 fail-fast 回 500，不产裸卡片 */
export function machineLineOf(action, payload) {
	if (action === "bash") {
		const cmd = String(payload?.command ?? "");
		for (const r of BASH_RED_RES) if (r.re.test(cmd)) return `[红区] ${r.name}`;
		for (const r of BASH_AMBER_RES) if (r.re.test(cmd)) return `[灰区] ${r.name}`;
		throw new Error(`machineLine 生成失败：bash 命令命中不了红/灰区规则名（command=${cmd.slice(0, 80)}）`);
	}
	const tier = classify(action, payload);
	if (tier === "red" || tier === "amber") return `[${tier === "red" ? "红区" : "灰区"}] ${action}`;
	throw new Error(`machineLine 生成失败：action=${action} 不在红/灰区（silent 不进审批）`);
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

	/** 红区请求入队。返回完整卡片（pending 态）。
	 *  origin="request" = 分身上浮卡（/approvals/request，定案①拍板2/6）——decide 批准后
	 *  壳不代跑，只置状态待分身重试；机器行生成失败（白卡）在此抛错，调用方 fail-fast 不产裸卡片（拍板8） */
	request(action, payload, agent, intent, origin = null) {
		const id = `ap_${Date.now().toString(36)}_${++approvalSeq}`;
		const item = {
			id,
			action,
			agent: agent ?? "unknown",
			summary: describe(action, payload, intent),
			impact: impactOf(action, payload),
			machineLine: machineLineOf(action, payload), // 机器行：classify 结果+命中规则名（壳侧生成）
			plainLine: describe(action, payload, intent), // 白话行：describe 人话（intent 前置+动作人话）
			commandHash: action === "bash" ? commandHash(payload?.command) : null, // 已批单次放行匹配键
			origin,
			raw: { action, payload: payload ?? null },
			status: "pending", // pending | executed | denied
			consumedAt: null, // 已批单次放行被消费的时刻（拍板5：null=未消费，可放行一次）
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

	/** 已批单次放行（定案①拍板5）：同 commandHash 的已批（executed）未消费卡 → 记
	 *  consumedAt 返回该卡；找不到返回 null（调用方重新入队——同一命令二次高危仍要走人）。
	 *  只认 origin="request" 的上浮卡：壳代跑卡（grimoire/沙箱）的批准不背书分身进程重跑。
	 *  消费也记审计——暗区不许无痕 */
	consumeApproved(hash, by) {
		for (const item of this.items.values()) {
			if (item.origin !== "request" || item.status !== "executed") continue;
			if (item.commandHash !== hash || item.consumedAt) continue;
			item.consumedAt = new Date().toISOString();
			this.audit({ id: item.id, action: item.action, agent: item.agent, consume: true, by: by ?? "relay-retry", ts: item.consumedAt });
			return item;
		}
		return null;
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

	/** 认领报备（T3 notify_claim）：summary 是 agent 自述一句话，不走 describe 模板——报备的正文就是原话，再套人话模板会盖掉。带 action 位供 /notify/since 消费端区分形状 */
	claim(agent, summary, ticket) {
		const n = {
			id: `nt_${Date.now().toString(36)}_${++this.seq}`,
			ts: new Date().toISOString(),
			action: "notify_claim",
			agent: agent ?? "unknown",
			summary: String(summary).slice(0, 500),
			ticket: ticket ?? null,
			impact: impactOf("notify_claim"),
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
