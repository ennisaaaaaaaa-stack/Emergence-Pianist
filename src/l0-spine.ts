/**
 * Pianist L0 会话主干 —— 施工①核心
 *
 * 职责（arch-v2「会话编排分层」L0 内核）：
 * 1. session 桥接：切 session 时 (T_r, T_s] 区间切片原文 + 衔接包（v3 增量②，2026-10-17：
 *    复盘起笔记 coverage offset T_r，桥接包=所有没被复盘过的上下文——替代旧固定尾巴 N=20；
 *    增量①：桥接层归 pianist 壳，衔接包=原文精确搬运，tideline 注入只配语义层不配桥接层）
 * 2. narrative 最简压缩：机制归 runtime、实现可插拔
 *    —— 没配记忆时 runtime 自己蒸馏（最简压缩，零依赖零 Tideline）
 *    —— 配了 Tideline 同一钩子位升级为注入（Tideline 是实现不是前提）
 * 3. L0 是所有拔插头清单里「拔完必须活着」的那层
 *
 * 驱动面：AgentSessionRuntime（newSession/switchSession/fork 都在这层）
 * Pi 版本锁定：@earendil-works/pi-coding-agent@0.85.1
 */
import {
	type AgentSessionEvent,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
} from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// L0 配置
//   阈值可配（v3 活3，2026-10-17）：contextThreshold / narrativeStartLine 进 env 可配
//   （PIANIST_L0_CONTEXT_THRESHOLD / PIANIST_L0_NARRATIVE_START_LINE）——不同模型上下文尺寸
//   不同，配置面必须有；缺省 100_000 / 95_000 不变（与 9/15-16 定案一致）。非法/非正整数回退缺省。
// ---------------------------------------------------------------------------

/** env 名导出（测试/文档同源） */
export const L0_CONTEXT_THRESHOLD_ENV = "PIANIST_L0_CONTEXT_THRESHOLD";
export const L0_NARRATIVE_START_LINE_ENV = "PIANIST_L0_NARRATIVE_START_LINE";

function envInt(name: string, dflt: number): number {
	const raw = process.env[name];
	if (raw == null || raw.trim() === "") return dflt;
	const n = Number.parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : dflt;
}

export interface L0Config {
	/** 上下文阈值（token）。到阈值等 idle 切 session。缺省 100k（env 可配） */
	contextThreshold: number;
	/** narrative 蒸馏起笔线（缺省 contextThreshold - 5k；env 可配） */
	narrativeStartLine: number;
	/** narrative 蒸馏实现（可插拔）。没配时用内置最简压缩 */
	distiller?: NarrativeDistiller;
}

export interface NarrativeDistiller {
	/** 把对话蒸馏成衔接叙述。机制归 runtime，实现可插拔 */
	distill(messages: unknown[]): Promise<string>;
}

export function defaultL0Config(): L0Config {
	return {
		contextThreshold: envInt(L0_CONTEXT_THRESHOLD_ENV, 100_000),
		narrativeStartLine: envInt(L0_NARRATIVE_START_LINE_ENV, 95_000),
	};
}

// ---------------------------------------------------------------------------
// 衔接包（bridge pack）
// ---------------------------------------------------------------------------

export interface BridgePack {
	/** 哪个 session 切过来的 */
	parentSessionFile: string | null;
	/** 蒸馏叙述（narrative 最简压缩产物）——覆盖 [0, T_r) 区间 */
	narrative: string;
	/** 骨架索引（只当索引不当记忆——任务ID/分支/工具摘要） */
	skeleton: SkeletonIndex;
	/**
	 * 桥接区间切片原文（v3 增量②，2026-10-17 定案）：(T_r, T_s] 全部原文——复盘（narrative 蒸馏）
	 * 起笔记 coverage offset T_r，切换时刻 T_s，桥接包=所有没被复盘过的上下文，到最后完整输出。
	 * 増量①：桥接层归 pianist 壳（本类即壳侧）——谁有原文谁桥接，衔接包=原文精确搬运；
	 * tideline 注入配 T0/T3 语义层不配 T2b 桥接层（库未接，不在此造调用）。
	 */
	tailMessages: unknown[];
	/** coverage offset T_r：蒸馏起笔时已覆盖的消息数（区间切片的左端——与 narrative 同源） */
	coverageOffset: number;
}

export interface SkeletonIndex {
	sessionFile: string;
	timestamp: string;
	toolCalls: number;
	toolsUsed: string[];
	tasks: string[];
}

/** 骨架只当索引不当记忆：任务ID/分支/工具摘要，不含对话内容 */
export function buildSkeleton(
	sessionFile: string,
	messages: unknown[],
): SkeletonIndex {
	const toolsUsed = new Set<string>();
	let toolCalls = 0;
	for (const m of messages as Array<{ toolCalls?: Array<{ name?: string }> }>) {
		for (const tc of m.toolCalls ?? []) {
			toolCalls++;
			if (tc.name) toolsUsed.add(tc.name);
		}
	}
	return {
		sessionFile,
		timestamp: new Date().toISOString(),
		toolCalls,
		toolsUsed: [...toolsUsed],
		tasks: [],
	};
}

// ---------------------------------------------------------------------------
// L0 主干
// ---------------------------------------------------------------------------

export class L0Spine {
	private config: L0Config;
	private runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | null = null;
	private unsubscribe: (() => void) | null = null;
	private distillStarted = false;
	private narrativeText: string | null = null;
	/** coverage offset T_r（v3 增量②）：复盘（narrative 蒸馏）起笔时已覆盖的消息数 */
	private coverageOffset: number | null = null;
	private bridgeCount = 0;
	private disposed = false;

	constructor(config: Partial<L0Config> = {}) {
		this.config = { ...defaultL0Config(), ...config };
	}

	/** 开机。返回当前 session 文件路径 */
	async start(cwd: string): Promise<string | undefined> {
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
			const services = await createAgentSessionServices({ cwd });
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		this.runtime = await createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir: getAgentDir(),
			sessionManager: SessionManager.create(cwd),
		});
		await this.bindSession();
		return this.runtime.session.sessionFile;
	}

	/** 切 session 后重绑订阅和 extension（官方模式） */
	private async bindSession() {
		this.unsubscribe?.();
		const session = this.runtime!.session;
		await session.bindExtensions({});
		this.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
			void this.onEvent(event);
		});
	}

	/** 事件泵：上下文监控 + narrative 起笔线检查（message_update=流中；message_end=一条完整消息落账——v3 增量②起笔记位需要的时刻） */
	private async onEvent(event: AgentSessionEvent) {
		if (this.disposed || !this.runtime) return;
		if (event.type !== "message_update" && event.type !== "message_end") return;
		const usage = this.getContextUsage();
		if (usage == null) return;
		if (!this.distillStarted && usage >= this.config.narrativeStartLine) {
			this.distillStarted = true;
			void this.distillNarrative().catch(() => {});
		}
	}

	/** 上下文用量（token）。原生 getContextUsage 优先，未知时回退字符粗估 */
	getContextUsage(): number | null {
		const session = this.runtime?.session;
		if (!session) return null;
		// Pi 原生估算（压缩刚完成、下轮响应未到时 tokens 为 null）
		const native = session.getContextUsage();
		if (native?.tokens != null) return native.tokens;
		// 回退粗估：字符数/4
		const messages = session.messages;
		if (!messages) return null;
		let chars = 0;
		for (const m of messages as Array<{ content?: unknown }>) {
			const c = m.content;
			if (typeof c === "string") {
				chars += c.length;
			} else if (Array.isArray(c)) {
				for (const part of c as Array<{ text?: string }>) {
					chars += part.text?.length ?? 0;
				}
			}
		}
		return Math.round(chars / 4);
	}

	/** 95k 起笔：narrative 最简压缩（实现可插拔，没配用内置）——起笔时记 coverage offset T_r */
	private async distillNarrative(): Promise<void> {
		const session = this.runtime!.session;
		const messages = [...session.messages];
		// 增量② coverage offset（v3 10/17）：复盘起笔时壳记已覆盖消息数 T_r——切换时桥接包 =
		// (T_r, T_s] 区间切片，系统层两数相减零 LLM。蒸馏恰覆盖 [0, T_r)，切片恰取 [T_r, T_s)，
		// 同一数两个消费面——零缝隙零重叠是构造性质，不靠对齐靠构造（连续性靠构造不靠运气）。
		this.coverageOffset = messages.length;
		const distiller = this.config.distiller;
		try {
			this.narrativeText =
				distiller != null
					? await distiller.distill(messages)
					: builtinMinimalDistill(messages);
		} catch {
			this.narrativeText = builtinMinimalDistill(messages);
		}
	}

	/** 切 session：组衔接包 → newSession → 注入衔接包 */
	async bridgeToNewSession(): Promise<BridgePack | null> {
		if (!this.runtime) return null;
		const session = this.runtime.session;
		const parentFile = session.sessionFile ?? null;
		const messages = [...session.messages];

		// 1) narrative：还没起笔就当场补（session 提前死回串行路）——当场补的蒸馏覆盖全部消息，
		//    T_r=T_s（区间切片为空——构造性质零重叠：全覆盖+空切片，不靠对齐）
		if (this.narrativeText == null) {
			await this.distillNarrative();
		}

		// 2) 组衔接包——桥接区间切片（v3 增量②）：桥接包 = (T_r, T_s] 全部原文（复盘覆盖区之后
		//    → 切换时刻最后一条完整消息）。替代旧固定尾巴（bridgeTailMessages:20）——固定尾巴
		//    与复盘覆盖区的缝隙/重叠靠运气，区间切片靠构造：两数同源（coverageOffset 即蒸馏时的
		//    messages.length），零缝隙零重叠；多轮切换链式自然成立（新场起笔再记新 T_r）。
		const tr = this.coverageOffset ?? messages.length;
		const tail = messages.slice(tr);
		const skeleton = buildSkeleton(parentFile ?? "", messages);
		const pack: BridgePack = {
			parentSessionFile: parentFile,
			narrative: this.narrativeText!,
			skeleton,
			tailMessages: tail,
			coverageOffset: tr,
		};

		// 3) 原子切换
		await this.runtime.newSession();
		await this.bindSession();

		// 4) 注入衔接包：新 session 第一条消息 = 衔接叙述 + 骨架索引
		//    注入失败不拖死桥接（拔插头思维：切换已原子完成，注入可重试）
		this.bridgeCount++;
		const bridgeMessage = [
			`[pianist L0 桥接 #${this.bridgeCount}]`,
			`来自父 session：${pack.parentSessionFile ?? "(无)"}`,
			`narrative：${pack.narrative}`,
			`骨架（索引非记忆）：${skeletonSummary(pack.skeleton)}`,
			`桥接区间原文 ${pack.tailMessages.length} 条（=(T_r,T_s] 区间切片——复盘覆盖后全部原文，零缝隙零重叠）已存衔接包，可经 runtime.switchSession(parentFile) 取回`,
		].join("\n");
		try {
			await this.runtime.session.prompt(bridgeMessage);
		} catch (err) {
			// 无 key / 模型未配时走到这里——衔接包已组好返回给调用方
			// TODO: 壳骨架建起后改走 settled/appendEntry 通道，不占用户位
			this.lastBridgeInjectError = err instanceof Error ? err.message : String(err);
		}

		return pack;
	}

	/** 上次衔接包注入的失败信息（null=成功）。诊断用 */
	lastBridgeInjectError: string | null = null;

	/** 拔插头验收：拔掉全部上层环，L0 必须活着 */
	async dispose(): Promise<void> {
		this.disposed = true;
		this.unsubscribe?.();
		this.runtime?.dispose();
	}

	get sessionFile(): string | undefined {
		return this.runtime?.session.sessionFile;
	}

	get bridgeCountTotal(): number {
		return this.bridgeCount;
	}
}

// ---------------------------------------------------------------------------
// 内置最简压缩（零依赖零 Tideline）
// ---------------------------------------------------------------------------

/** 最简压缩：轮次计数 + 工具调用摘要。机械统计，零 LLM */
export function builtinMinimalDistill(messages: unknown[]): string {
	let user = 0;
	let assistant = 0;
	let toolCalls = 0;
	const tools = new Map<string, number>();
	for (const m of messages as Array<{
		role?: string;
		toolCalls?: Array<{ name?: string }>;
	}>) {
		if (m.role === "user") user++;
		if (m.role === "assistant") assistant++;
		for (const tc of m.toolCalls ?? []) {
			toolCalls++;
			if (tc.name) tools.set(tc.name, (tools.get(tc.name) ?? 0) + 1);
		}
	}
	const toolSummary = [...tools.entries()]
		.map(([name, n]) => `${name}x${n}`)
		.join(", ");
	return [
		`本段对话共 ${user} 条用户消息、${assistant} 条回复、${toolCalls} 次工具调用。`,
		`工具分布：${toolSummary || "无"}。`,
		`（最简压缩——零 LLM 机械统计；配 Tideline 后此位升级为质感叙述）`,
	].join("\n");
}

function skeletonSummary(s: SkeletonIndex): string {
	return `file=${s.sessionFile} ts=${s.timestamp} toolCalls=${s.toolCalls} tools=[${s.toolsUsed.join(",")}] tasks=${s.tasks.length}`;
}
