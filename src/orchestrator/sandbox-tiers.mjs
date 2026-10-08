/**
 * sandbox-tiers.mjs — 沙箱档位映射（任务编排器⑧ 第一铲·真身接线）
 *
 * 是什么：角色/任务书沙箱列 → policyPath 的纯映射表 + enforcement 诚实报告。
 * 蓝图出处：EP-Orchestrator.md §9（the author v0 定案·角色×任务默认表）；拍板表#6。
 *
 * §9 表（数据不是代码——表是权威）：
 *   施工分身   → default.policy（网开：装依赖要出网）
 *   审链临时工 → no-ext-net.policy（禁外网：空白名单=全拒，诚实降级不是假装断网）
 *   查询临时工 → default.policy（网开：查资料）
 *   前台主agent → null（监护面不进沙箱）
 * 任务书沙箱列可覆盖默认档（§9「任务书可覆盖」）；覆盖语义：
 *   含「禁外网/no-ext-net/闭网/断网」→ no-ext-net；值全等「无沙箱/不进沙箱/无/none/null」→ null；
 *   只写「workspace-write」→ default。列缺省走角色默认表。
 *
 * enforcement 诚实报告（§9「不假装完全隔离」）：
 *   "partial" = 轻档·内核原语（Landlock+Seccomp+netns，sandbox/engine-registry.mjs 在册）——
 *               挡得住已知泄密通道，不是完全隔离；"full"（microVM）是接口位未施工，
 *               本表永不返回 full——返回了就是谎报。
 *   null = 不进沙箱。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_POLICY_DIR = path.resolve(__dirname, "..", "..", "sandbox", "policies");

/** 档位名 → 策略文件名（档位是词法，路径只在这里拼） */
export const TIER_POLICY_FILES = {
	default: "default.policy.json",
	"no-ext-net": "no-ext-net.policy.json",
};

/** 沙箱列覆盖标记：禁外网形 / 无沙箱形 */
const SANDBOX_CLOSED_RE = /禁外网|no-ext-net|闭网|断网/i;
const SANDBOX_NONE_RE = /^(无沙箱|不进沙箱|无|none|null|no-sandbox)$/i;

/** 角色匹配（§9 表的角色是人话不是枚举：「审临时工」「审链临时工」同落禁外网档） */
function roleDefaultTier(role) {
	if (typeof role !== "string" || !role.trim()) return { tier: "default", basis: "role-table(角色空，落 default 档)" };
	if (/前台/.test(role)) return { tier: null, basis: "role-table(前台主agent·监护面不进沙箱)" };
	if (/审/.test(role) && /临时工/.test(role)) return { tier: "no-ext-net", basis: "role-table(审链临时工·禁外网)" };
	if (/施工|查询/.test(role)) return { tier: "default", basis: `role-table(${role})` };
	// 未知角色：落 default 档（§9 表缺行不是拒派的理由，但 basis 出声——诚实报告映射来源）
	return { tier: "default", basis: `role-table(角色「${role}」不在 §9 表，落 default 档——任务书可显式覆盖)` };
}

/**
 * 解析档位：任务书沙箱列优先，列缺省走 §9 角色默认表。
 * @param {object} p { role: string, sandbox?: string|null }（sandbox=角色表「沙箱」列原值）
 * @param {object} opts { policyDir?: string }（测试可注入夹具目录）
 * @returns {{ tier: 'default'|'no-ext-net'|null, policyPath: string|null, enforcement: 'partial'|null, basis: string }}
 *   tier=null → 直接 spawn 不进沙箱；tier 有值 → policyPath 存在性 fail-fast（接线坏了要出声，不是 spawn 时才炸）。
 */
export function resolveSandboxTier({ role, sandbox = null } = {}, { policyDir = DEFAULT_POLICY_DIR } = {}) {
	let tier;
	let basis;
	const col = typeof sandbox === "string" ? sandbox.trim() : "";
	if (col) {
		if (SANDBOX_NONE_RE.test(col)) {
			tier = null;
			basis = `column(沙箱:${col}·显式不进沙箱)`;
		} else if (SANDBOX_CLOSED_RE.test(col)) {
			tier = "no-ext-net";
			basis = `column(沙箱:${col}·禁外网)`;
		} else {
			tier = "default";
			basis = `column(沙箱:${col})`;
		}
	} else {
		({ tier, basis } = roleDefaultTier(role));
	}

	if (tier == null) return { tier: null, policyPath: null, enforcement: null, basis };
	const policyPath = path.join(policyDir, TIER_POLICY_FILES[tier]);
	if (!fs.existsSync(policyPath)) {
		throw new Error(`沙箱档位「${tier}」策略文件不存在：${policyPath}（接线坏了要出声，不是 spawn 时才炸）`);
	}
	// enforcement 诚实：轻档=partial；full（microVM）未施工，永不谎报
	return { tier, policyPath, enforcement: "partial", basis };
}
