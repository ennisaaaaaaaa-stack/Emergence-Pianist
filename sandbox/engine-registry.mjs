// sandbox/engine-registry.mjs —— 执行器引擎注册表：一份契约，两档引擎（T9 定案）
// 轻档=内核原语（Landlock+Seccomp+netns，已施工）；重档=microVM 接口位（仅声明，不施工）。
// 启用判据（docs/t9-microvm-scope.md §六）：第一个第三方 agent 入住、或第一次跨家门 agent 协作。
// 本文件不 import 任何重档实现——接口位只存在于契约与类型形状里，启用那天才落第一行实现代码。

/** 引擎描述：注册表里的一个条目 */
export const ENGINES = {
	kernel_primitives: {
		id: "kernel_primitives",
		label: "轻档·内核原语（Landlock+Seccomp+netns）",
		status: "active", // active=可用 | reserved=接口位，未施工
		/** 执行入口：与 executor.runSandboxed 同契约——
		 *  ({command, policyPath, agent, timeoutMs, env}) → {code, signal, journaledHosts}
		 *  轻档直接指到现有执行器；重档启用那天在这里换成 microVM 执行器，调用方零改动。 */
		run: undefined, // 动态填（见文件尾），避免循环 import
	},
	microvm: {
		id: "microvm",
		label: "重档·microVM（Firecracker/gVisor 届时选型）",
		status: "reserved",
		/** 启用条件（三选一即触发）：
		 *  1) Portalk 开放第三方 agent 入住（不可信代码进场）
		 *  2) 第一次跨家门 agent 协作（对等 runtime 互调）
		 *  3) 轻档实测挡不住的威胁类出现（届时先补威胁模型再动工）
		 * 启用日工序：选型评审 → 实现 run()（同契约）→ 契约测试转真 → ENGINES.microvm.status="active"
		 * 注意：重档与轻档共用同一份策略语言（同一 policy 文件），执行器不同。 */
		run: undefined,
	},
};

/** 解析策略的 engine 字段 → 引擎条目。缺省=轻档（向后兼容既有策略文件）。 */
export function resolveEngine(policy) {
	const id = policy?.engine ?? "kernel_primitives";
	const e = ENGINES[id];
	if (!e) throw new Error(`策略 engine 未知: ${id}（在册: ${Object.keys(ENGINES).join(", ")}）`);
	if (e.status !== "active")
		throw new Error(
			`引擎 ${id} 是接口位未施工（status=${e.status}）——启用条件见 docs/t9-microvm-scope.md §六。` +
				`当前请用轻档 kernel_primitives（策略里删掉 engine 字段即可）`,
		);
	return e;
}
