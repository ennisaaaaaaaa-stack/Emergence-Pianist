/**
 * bridge-catalog — pianist_bridge 的 action 目录（单一事实源）
 *
 * 缘起（retro 工单 pianist-bridge-tool-desc-enumerate-actions，2026-10-11）：
 * 桥工具 description 只写「转发壳分发」，action 为无枚举裸 string——每个新 session
 * 都在盲猜 API 面（status×17 不存在、spoor_status 缺 project×28…，错误热点榜前二，
 * 2026-09-30~10-11 累计约 78 次失败调用，两度被 retropad 落单）。
 *
 * 单源纪律（同 BASH_RED_RES 先例：不抄第二份）：
 *   - 动作清单 = 壳 TOOL_ROUTES 的键（test/bridge-catalog-test.mjs 源码解析 shell.mjs 对账）；
 *   - 分层 red/amber/silent = queue-core classify() 运行时取（目录文本渲染时现算，永不漂）；
 *   - 写面人话 = queue-core describe()（测试断言与 catalog.sum 逐字一致）；
 *   - 载荷必填字段 = 三 spoor MCP server tools/list（2026-10-15 实探）+ sandboxInvoke 源码
 *     need() 面 + shell claim 分支 + grimoire POST 面（缺name/kind 报错实测）。
 *
 * 已知错位（不藏）：queue-core ACTION_RISK 列了 spoor_archive_pin/unpin/link 三动作，
 * 壳 TOOL_ROUTES 未路由（调了必得「未知工具」）——KNOWN_UNROUTED_RISK 钉名，测试对账，
 * 谁路由或删表谁更新这里。
 */
import { classify } from "./queue-core.mjs";

/** 目录条目：args=必填载荷（空串=无必填），opt=常用可选，sum=一句话（写面动作须与 describe() 一致） */
export const BRIDGE_CATALOG = {
	// Grimoire 读面
	grimoire_map: { args: "", note: "拉开场经图全文（与记忆注入同源）" },
	grimoire_tag: { args: "tag", note: "拉某 tag 山下条目（含首行描述）" },
	grimoire_skill: { args: "id 或 name", note: "拉一本 skill 正文" },
	grimoire_darkzone: { args: "", note: "拉待审区 draft 名单" },
	grimoire_stats: { args: "", note: "拉经图库统计" },
	// Grimoire 写面（走壳审批/写队列）
	grimoire_submit: { args: "name", opt: "正文等投审载荷", sum: "往Grimoire提交一本新 skill 书" },
	grimoire_submit_auto: { args: "name（须 auto/ 前缀）", sum: "往Grimoire新兵区提交一本 auto/ skill 书（四道闸已过）" },
	grimoire_event: { args: "kind（9 合法值，报错即列全）", opt: "kind 伴生字段", sum: "往Grimoire事件账本追加一条记录" },
	// spoor 工作台（workbench）
	spoor_list: { args: "", note: "列全部工作台项目" },
	spoor_search: { args: "query", opt: "type,project,agent,limit", note: "跨账本搜工作记录" },
	spoor_journal: { args: "project, entry", opt: "mark", sum: "往猎迹工作台追加一条工作记录" },
	spoor_read_journal: { args: "project", opt: "mark,limit,reason", note: "读工作台日志" },
	spoor_status: { args: "project", opt: "text", sum: "刷新猎迹项目的进行中状态板" },
	spoor_snippet: { args: "project, name", opt: "content", sum: "在猎迹工作台存一段复用代码" },
	// spoor 档案房（archive，append-only 家底）
	spoor_archive_get: { args: "doc", opt: "version_id,reason", note: "读档案（默认钉住版）" },
	spoor_archive_list: { args: "", opt: "doc", note: "列档案/版本" },
	spoor_archive_put: { args: "doc, content", opt: "parent_version,source_ref", sum: "往档案房归档一个新版本" },
	spoor_archive_query: { args: "query", opt: "limit", note: "全文查档案房" },
	// spoor 涂鸦房（scratchpad，临时工）
	spoor_scratch_create: { args: "task_id", opt: "label", sum: "创建一间临时涂鸦房" },
	spoor_scratch_write: { args: "space_id, path, content", opt: "mode", sum: "往涂鸦房写文件" },
	spoor_scratch_read: { args: "space_id, path", opt: "offset,limit", note: "读涂鸦房文件" },
	// 沙箱（隔离容器，命令深判复用 bash 红灰区）
	sandbox_execute: { args: "command", opt: "requestId,timeoutMs,cwd,env,deployment", sum: "在一次性沙箱容器里跑命令" },
	sandbox_create_session: { args: "", opt: "deployment,timeoutMs", sum: "开一间沙箱会话（新起一个隔离容器）" },
	sandbox_run_in_session: { args: "sessionId, command", opt: "同 execute", sum: "在沙箱会话里跑命令" },
	sandbox_close_session: { args: "sessionId", sum: "关掉一间沙箱会话" },
	sandbox_read_file: { args: "sessionId, path", sum: "读沙箱容器里的文件" },
	sandbox_write_file: { args: "sessionId, path, content", sum: "往沙箱容器里写文件" },
	sandbox_upload: { args: "sessionId, files", sum: "往沙箱容器批量上传文件" },
	sandbox_is_alive: { args: "sessionId", sum: "探一下沙箱会话是否还活着" },
	sandbox_close: { args: "", sum: "关掉全部沙箱会话" },
	// 认领报备（T3）：只进通知环，不写任何东西
	notify_claim: { args: "summary", opt: "ticket", note: "分身认领报备（谁认领了什么，一句话）" },
};

/** queue-core ACTION_RISK 有、壳 TOOL_ROUTES 未路由的动作（调必「未知工具」）——钉名对账，防两张表悄悄分叉 */
export const KNOWN_UNROUTED_RISK = ["spoor_archive_pin", "spoor_archive_unpin", "spoor_archive_link"];

/** 渲染目录文本（写进 pianist_bridge 的 tool description）。分层标记现算 classify——永不与正则表漂移 */
export function bridgeCatalogText() {
	const line = (name) => {
		const e = BRIDGE_CATALOG[name];
		const tier = classify(name);
		const fields = e.args ? `{${e.args}}` : "{}";
		const desc = e.sum ?? e.note;
		const opt = e.opt ? `（可选 ${e.opt}）` : "";
		return `- ${name}${fields}${opt}：${desc} [${tier}]`;
	};
	const names = Object.keys(BRIDGE_CATALOG);
	const head = `合法 action 共 ${names.length} 个（单源 src/bridge-catalog.mjs；必填字段进 payload；标记 [red]=挂审批卡 [amber]=进写队列 [silent]=直行）：`;
	return [head, ...names.map(line)].join("\n");
}

/** 测试面：写面动作的人话必须与审批卡 describe() 逐字一致（两处叙述，一个源头校验） */
export function catalogSums() {
	return Object.fromEntries(
		Object.entries(BRIDGE_CATALOG)
			.filter(([, e]) => typeof e.sum === "string")
			.map(([k, e]) => [k, e.sum]),
	);
}
