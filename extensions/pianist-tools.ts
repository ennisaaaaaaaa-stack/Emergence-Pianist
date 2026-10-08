/**
 * pianist-tools — 薄桥 extension（施工①第一块积木）
 *
 * 三层架构里的 extension 层：原版 Pi 进程内，壳分发的工具经这里注册，
 * 内部 HTTP 找壳要。三件套钩子位：审批拦截 / 记忆注入 / 账本桥。
 *
 * 架构依据：桌面 arch-v2「Runtime 定型」节 / spoor 档案 pianist-runtime-dependency-map v2
 * Pi 版本锁定：@earendil-works/pi-coding-agent@0.85.1（tag pianist-lock-20260919）
 *
 * 开发期形态（TODO 施工①「开发期薄桥」）：壳骨架缓建，先直挂本地 MCP——
 * 本文件不依赖壳存在，PIANIST_SHELL_URL 未设时桥工具降级为「未接线」占位，
 * L0 验收（拔插头清单）不受影响。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
// 红区判定单一事实源（the user 10/7 定案①拍板4）：从壳的 queue-core import，不抄第二份正则。
// 壳不在场时本地拦死用的也是同一把尺——两侧永远同尺。queue-core 是纯函数模块，无副作用。
//
// ⚠️ 加载位形状（10/8 生产事故修法）：生产加载路径是 ~/.pi/agent/extensions/pianist-tools.ts
// 符号链接——pi 的 jiti 从【链接路径】解析相对 import，../src/ 落到不存在的
// /root/.pi/agent/src/，02:12 起全部真 spawn 断（repo 内测试走真身路径，测不出这病）。
// 正解=realpathSync 解回真身再 createRequire，两条加载路径（链接位/repo 内）都活；
// 急切加载保持 fail-fast：尺子模块缺失时整个 extension 拒载，审批线永不静默失尺。
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const requireFromReal = createRequire(realpathSync(fileURLToPath(import.meta.url)));
const { BASH_RED_RES } = requireFromReal("../src/queue-core.mjs") as {
	BASH_RED_RES: { re: RegExp; name: string }[];
};

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const AGENT_ID = process.env.PIANIST_AGENT_ID ?? "pianist-dev-1";

/** 壳地址调用时读 env（非模块加载时捕获）——测试可注入 mock 壳，部署期语义不变 */
const shellUrl = () => process.env.PIANIST_SHELL_URL ?? "";

/** 遥测批量上报窗口（条）。攒满即发，不攒满等 session 边界或 settled 兜底 */
const TELEMETRY_BATCH = 25;

/** 遥测钩子开关（默认开；关闭时纯零开销——不注册任何监听器） */
const TELEMETRY_ON = process.env.PIANIST_TELEMETRY !== "off";

/** 开发期：壳不在场时桥工具的行为（TODO: 壳骨架建起来后接线） */
async function shellFetch(path: string, init?: RequestInit): Promise<unknown> {
	if (!shellUrl()) {
		throw new Error(
			"pianist-tools: shell not wired (PIANIST_SHELL_URL unset) — dev phase, bridge tool is a stub",
		);
	}
	const res = await fetch(`${shellUrl()}${path}`, init);
	if (!res.ok) {
		throw new Error(`pianist-tools: shell ${path} -> HTTP ${res.status}`);
	}
	return res.json();
}

// ---------------------------------------------------------------------------
// 三件套钩子位
// ---------------------------------------------------------------------------

/** 审批拦截（the user 10/7 定案①）：tool_call 事件，fail-closed。
 * 上浮形状 = block + 入队 + 已批重试放行（拍板1）——pi 钩子返回面只有
 * { block, reason, terminate }，不能挂起等人；裁决后不通知分身进程，
 * 分身看 block reason 自行决定：等已批重试 / 换安全做法 / BLOCKED:环境 报告退出。
 * 红区判定用 BASH_RED_RES（单一事实源）；灰区不触发上浮（amber 维持现状）。 */
type RelayOutcome =
	| { kind: "pass" } // 已批单次放行：这次不拦（单次性由壳侧 consumedAt 钉死）
	| { kind: "card"; id: string; machineLine: string } // 入队成功：block + 卡片人话
	| { kind: "degraded"; why: string }; // 壳不在场/上浮失败：降级本地拦死 + 出声

/** 上浮：壳在场（PIANIST_SHELL_URL 设了且 /health 通，拍板4）→ POST /approvals/request。
 *  机器行+白话行壳侧生成，不信调用方自报；这里只带回卡片 id+机器行进 reason。 */
async function relayApproval(command: string): Promise<RelayOutcome> {
	const base = shellUrl();
	if (!base) return { kind: "degraded", why: "PIANIST_SHELL_URL 未设（壳不在场）" };
	try {
		const health = await fetch(`${base}/health`);
		if (!health.ok) throw new Error(`/health -> HTTP ${health.status}`);
		const res = await fetch(`${base}/approvals/request`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agent: AGENT_ID, action: "bash", payload: { command } }),
		});
		if (!res.ok) throw new Error(`/approvals/request -> HTTP ${res.status}`);
		const out = (await res.json()) as { pass?: unknown; approval?: { id?: unknown; machineLine?: unknown } };
		if (out?.pass === true) return { kind: "pass" }; // 已批同命令：放行这一次
		const id = out?.approval?.id;
		const machineLine = out?.approval?.machineLine;
		if (typeof id === "string" && id && typeof machineLine === "string" && machineLine) {
			return { kind: "card", id, machineLine };
		}
		throw new Error("响应缺卡片 id/machineLine（形状不对按失败处理，fail-closed）");
	} catch (err) {
		return { kind: "degraded", why: `上浮失败：${String((err as { message?: unknown })?.message ?? err)}` };
	}
}

function wireApproval(pi: ExtensionAPI) {
	pi.on("tool_call", async (event, _ctx) => {
		// 人类视线三层里的审批线入口。红区（BASH_RED_RES 单一事实源）上浮壳审批队列；
		// 真机字段是 input（BashToolInput）；args 兜底兼容测试桩
		if (event.toolName === "bash") {
			const raw = (event as { input?: { command?: string }; args?: { command?: string } });
			const command = String(raw.input?.command ?? raw.args?.command ?? "");
			if (BASH_RED_RES.some((r) => r.re.test(command))) {
				const relay = await relayApproval(command);
				if (relay.kind === "pass") return undefined;
				if (relay.kind === "card") {
					return {
						block: true,
						reason: `高危命令已上浮审批（卡片 ${relay.id}，机器行 ${relay.machineLine}）。裁决前勿重试同类命令：已批后重试同一命令将放行一次；被拒请换安全做法或输出 BLOCKED:环境 报告`,
					};
				}
				// 壳不在场/上浮失败 → 降级本地拦死 + 出声（上浮失败≠放行，拍板4/纪律）
				console.warn(
					`[pianist-approval] 高危命令降级本地拦死（${relay.why}，agent=${AGENT_ID}）：${command.slice(0, 80)}`,
				);
				return {
						block: true,
						reason: `pianist approval: 高危命令本地拦死（${relay.why}，agent=${AGENT_ID}）——换安全做法，或输出 BLOCKED:环境 报告`,
				};
			}
		}
		return undefined;
	});
}

/** 记忆注入：context 事件，每次 LLM 调用前非破坏性 prepended。 */
function wireMemoryInjection(pi: ExtensionAPI) {
	// 注入链设计位：Grimoire经图（开场）+ Tideline provider 链（T0-T4，以后接这里）。
	// 竞态修复（9/20 实测）：缓存 promise 而非值，context 钩子 await——第一发就带上。
	// 缓存纪律（9/20 二修）：null/失败不缓存——壳上线或恢复后下一轮 LLM 调用即拿到经图；
	// 成功结果才定格（经图会变，但按 session 粒度刷新足够）。
	let mapPromise: Promise<string | null> | null = null;

	function fetchMap(): Promise<string | null> {
		if (!mapPromise) {
			mapPromise = (async () => {
				if (!shellUrl()) return null;
				try {
					const out = (await shellFetch("/tools/invoke", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ action: "grimoire_map", agent: AGENT_ID }),
					})) as { status?: number; body?: unknown };
					if (out?.status === 200 && typeof out.body === "string" && out.body.length > 0) {
						return out.body;
					}
				} catch {
					// 拉不到经图不阻塞会话
				}
				return null;
			})().then((m) => {
				if (m === null) mapPromise = null; // 失败不缓存，下一轮重试
				return m;
			});
		}
		return mapPromise;
	}

	pi.on("session_start", async () => {
		await fetchMap();
	});

	pi.on("context", async (event, _ctx) => {
		const m = await fetchMap();
		if (!m) return undefined; // 拉不到经图不阻塞会话
		return {
			messages: [
				{
					role: "user" as const,
					content: `[技能经图（Grimoire）]\n${m}\n[经图完——这是开场注入的技能地图，非用户发言]`,
					timestamp: Date.now(),
				},
				...event.messages,
			],
		};
	});
}

/** 贷本桥：pi.appendEntry 自定义条目（settled 侧——系统转述，不进 LLM context）。 */
function wireLedgerBridge(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, _ctx) => {
		try {
			pi.appendEntry("pianist.session_start", {
				agent: AGENT_ID,
				hook_active: true,
				ts: new Date().toISOString(),
				note: "L0 骨架：账本桥钩子位（开发期占位）",
			});
		} catch {
			// appendEntry 失败不阻塞会话——账本桥是旁挂，坏了变慢不变哑
		}
	});
}

// ---------------------------------------------------------------------------
// 第四件套：遥测钩子（施工③第一步）
// ---------------------------------------------------------------------------

/**
 * 自学习双闭环的接口面（v4 依赖地图、可拆卸性约束第 2 条）：
 * 主干→自学习 = 读壳层遥测存档（自学习只是读者之一）。
 *
 * 本钩子只做采集与转发，不聚合不判断——聚合热点是扫描器的活（第二步）。
 * 存档格式 v1（JSONL，每行一个事件）：
 *   { v: 1, ts: ISO, agent: string, session?: string, kind: string, data: ... }
 *
 * 事件面（写码前逐字段验过 *.d.ts）：
 *   - tool_execution_start/end：toolCallId + toolName + args/result + isError。
 *     用这对不用 tool_call/tool_result——这对带计时所需的完整形状（args 任意类型）
 *   - message_end：usage 字段（input/output/cacheRead/cacheWrite/totalTokens/cost）
 *   - agent_settled：回合边界。兜底冲刷（buffer 有剩但没攒满时）
 *   - session_shutdown：换 session/退出时冲刷
 *
 * 可拆卸性：壳不在场 → 事件丢弃（遥测坏了变慢不变哑，接口面两侧各自活着）
 */
/** 遥测事件（存档格式 v1，JSONL 每行一个） */
interface TelemetryEvent {
	v: 1;
	/** ISO 时间戳 */
	ts: string;
	agent: string;
	kind: "tool_use" | "message_end" | "session_mark";
	data: Record<string, unknown>;
}

function wireTelemetry(pi: ExtensionAPI) {
	if (!TELEMETRY_ON) return;

	let buffer: TelemetryEvent[] = [];
	const inflight: Map<string, { toolName: string; input: unknown; start: number }> = new Map();

	function enqueue(ev: Omit<TelemetryEvent, "v" | "ts" | "agent">) {
		buffer.push({ v: 1, ts: new Date().toISOString(), agent: AGENT_ID, ...ev });
		if (buffer.length >= TELEMETRY_BATCH) void flush();
	}

	// 洞1台账（collaborator A #708 裁决）：壳在场时 ingest 失败的丢弃必须出声——出声≠中断，
	// 丢弃行为不变（旁挂坏了变慢不变哑），但暗区不许无痕。拆卸态静默合法（取舍见 README）。
	let dropped = { batches: 0, events: 0, firstTs: null as string | null, lastReason: null as string | null };

	function noteDrop(batchLen: number, err: unknown) {
		dropped.batches += 1;
		dropped.events += batchLen;
		dropped.firstTs ??= new Date().toISOString();
		dropped.lastReason = String((err as { message?: unknown })?.message ?? err);
		console.warn(
			`[pianist-telemetry] ingest 失败：丢弃本批 ${batchLen} 条（累计 ${dropped.batches} 批/${dropped.events} 条）——${dropped.lastReason}`,
		);
	}

	/** session 边界汇总：把整场的丢弃账一次报清，报完清零 */
	function summarizeDrops() {
		if (dropped.batches === 0) return;
		console.warn(
			`[pianist-telemetry] session 汇总：ingest 失败 ${dropped.batches} 次，丢弃遥测 ${dropped.events} 条（首例 ${dropped.firstTs}，末因 ${dropped.lastReason}）`,
		);
		dropped = { batches: 0, events: 0, firstTs: null, lastReason: null };
	}

	async function flush() {
		if (buffer.length === 0) return;
		const batch = buffer;
		buffer = [];
		if (!shellUrl()) return; // 壳不在场=拆卸态：静默丢弃合法（不缓存——遥测是热数据不是账本）
		try {
			await shellFetch("/telemetry/ingest", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ agent: AGENT_ID, events: batch }),
			});
		} catch (err) {
			noteDrop(batch.length, err); // 壳在场：warn+计数出声，丢弃照旧
		}
	}

	pi.on("tool_execution_start", (event) => {
		inflight.set(event.toolCallId, {
			toolName: event.toolName,
			input: event.args,
			start: Date.now(),
		});
	});

	pi.on("tool_execution_end", (event) => {
		const rec = inflight.get(event.toolCallId);
		inflight.delete(event.toolCallId);
		enqueue({
			kind: "tool_use",
			data: {
				tool: event.toolName,
				input: rec?.input,
				isError: event.isError,
				durationMs: rec ? Date.now() - rec.start : null,
				resultBytes: event?.result?.content
					? JSON.stringify(event.result.content).length
					: 0,
			},
		});
	});

	pi.on("message_end", (event) => {
		const m = event.message as { role?: string; usage?: Record<string, unknown> };
		if (m?.role !== "assistant") return;
		enqueue({ kind: "message_end", data: { usage: m.usage } });
	});

	// 回合边界：buffer 有剩没攒满时兜底冲刷
	pi.on("agent_settled", () => {
		void flush();
	});

	// 换 session/退出：最后冲一次，然后出整场丢弃汇总（洞1：报完清零）
	pi.on("session_shutdown", async () => {
		await flush();
		summarizeDrops();
	});
}



// ---------------------------------------------------------------------------
// 薄桥壳工具位
// ---------------------------------------------------------------------------

/** 壳分发的工具经这里注册，内部 HTTP 找壳要（开发期：占位实现） */
function registerBridgeTools(pi: ExtensionAPI) {
	pi.registerTool({
		name: "pianist_bridge",
		label: "Pianist 桥",
		execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
			if (!shellUrl()) {
				return {
					content: [
						{
							type: "text",
							text: `pianist_bridge: 未接线（PIANIST_SHELL_URL 未设，agent=${AGENT_ID}）。壳骨架建起后此工具转发壳分发的 MCP 调用。`,
						},
					],
					details: { wired: false, agent: AGENT_ID },
				};
			}
			const out = await shellFetch("/tools/invoke", {
				method: "POST",
				headers: { "content-type": "application/json" },
				// agent 必须随调用过线（2026-09-29 wander）：壳的审批卡片/通知环/notify_claim 全靠这个
				// 字段记「谁在调」——丢了署名，T3 认领报备就报给 nobody（red 卡片同理）。
				body: JSON.stringify({
					action: (params as { action?: string }).action,
					payload: (params as { payload?: unknown }).payload,
					agent: AGENT_ID,
				}),
			});
			// 软错不软抛（2026-10-04 wander，③线；2026-10-07 wander 补深一层）：壳的失败信封
			// 是 HTTP 200 + 顶层 {error}（未知动作/提供者错），而 pi 的错误道唯一入口是
			// throw——返回值永远 isError:false，猜错动作名在 errorHotspots 里曾是隐形的
			// （env-event 六场空牌实证）。同病灶第二层：spoor 提供者原样透传 MCP result
			// {content,isError:true}（pydantic 缺参 4xx 等），曾同样作为数据返回、对热点层
			// 全黑——10-06 第四班「错形会落报告」预言被证伪即此缝。两层都 throw，message
			// 带原文报给模型。非失败信封照常返回：红牌等审批 {deferred}、读面状态码
			// {status,body}、MCP 成功 {content,isError:false} 是数据不是失败。
			const envelope = out as {
				error?: unknown;
				deferred?: unknown;
				isError?: unknown;
				content?: Array<{ text?: unknown }>;
			};
			const failText =
				typeof envelope?.error === "string"
					? envelope.error
					: envelope?.isError === true
						? String(envelope.content?.[0]?.text ?? "provider isError:true（无原文）")
						: null;
			if (failText !== null && !envelope.deferred) {
				throw new Error(
					`pianist_bridge ${String((params as { action?: string }).action)}: ${failText}`,
				);
			}
			return {
				content: [{ type: "text", text: JSON.stringify(out) }],
				details: { wired: true },
			};
		},
		parameters: Type.Object({
			action: Type.String({ description: "壳工具动作标识" }),
			payload: Type.Optional(Type.Object({}, { additionalProperties: true })),
		}),
		description:
			"Pianist 壳桥工具（开发期直挂占位）。壳在场时转发壳分发的 MCP 工具调用；未接线时返回未接线说明。",
	});
}

export default function pianistTools(pi: ExtensionAPI) {
	wireApproval(pi);
	wireMemoryInjection(pi);
	wireLedgerBridge(pi);
	wireTelemetry(pi);
	registerBridgeTools(pi);
}
