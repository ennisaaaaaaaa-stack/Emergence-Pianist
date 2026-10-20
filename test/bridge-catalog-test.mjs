// bridge-catalog 对账测试：目录 ↔ 壳 TOOL_ROUTES ↔ queue-core 三方不漂
// （retro 工单 pianist-bridge-tool-desc-enumerate-actions 配套——目录进 description 后，
//   名单漂移就不再是静默降级回「盲猜」，而是本测试红。）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { BRIDGE_CATALOG, KNOWN_UNROUTED_RISK, bridgeCatalogText, catalogSums } = await jiti.import(
	"../src/bridge-catalog.mjs",
);
const { classify, describe } = await jiti.import("../src/queue-core.mjs");

let pass = 0;
let total = 0;
function check(name, ok) {
	total++;
	if (ok) pass++;
	console.log(`${ok ? "PASS" : "FAIL"}: ${name}`);
}

// 1) 壳 TOOL_ROUTES 键集（源码解析——shell.mjs import 即起服务，不能真 import；
//    路由行形状唯一：制表符缩进 + `name: { kind: "..." }`）
const shellSrc = fs.readFileSync(path.join(repoRoot, "src/shell.mjs"), "utf8");
const routesBlock = shellSrc.slice(
	shellSrc.indexOf("const TOOL_ROUTES = {"),
	shellSrc.indexOf("/**", shellSrc.indexOf("const TOOL_ROUTES = {")),
);
const routed = new Set([...routesBlock.matchAll(/^\t([a-z_]+): \{ kind:/gm)].map((m) => m[1]));
const catalogNames = Object.keys(BRIDGE_CATALOG);

check(
	`目录 = 壳路由（目录 ${catalogNames.length} / 路由 ${routed.size}）`,
	catalogNames.length === routed.size && catalogNames.every((n) => routed.has(n)),
);

// 2) 风险表面（源码解析同源：classify 的回退默认 silent，故风险动作 = 源码 ACTION_RISK 键）
//    ⊆ 目录 ∪ KNOWN_UNROUTED_RISK（风险表里的动作要么可调，要么钉名记账）
const qcSrc = fs.readFileSync(path.join(repoRoot, "src/queue-core.mjs"), "utf8");
const riskBlock = qcSrc.slice(
	qcSrc.indexOf("const ACTION_RISK = {"),
	qcSrc.indexOf("};", qcSrc.indexOf("const ACTION_RISK = {")),
);
const riskNames = [...riskBlock.matchAll(/^\t([a-z_]+): "/gm)].map((m) => m[1]);
const unaccounted = riskNames.filter(
	(n) => !routed.has(n) && !KNOWN_UNROUTED_RISK.includes(n),
);
check(`风险表全部有去向（未路由且未钉名：${unaccounted.join(",") || "无"}）`, unaccounted.length === 0);
const KNOWN_UNROUTED_RISK_NOT_IN_RISK = KNOWN_UNROUTED_RISK.filter((n) => !riskNames.includes(n));
check(
	"钉名清单自身不过期（KNOWN_UNROUTED_RISK 都还在风险表里）",
	KNOWN_UNROUTED_RISK_NOT_IN_RISK.length === 0,
);

// 3) 写面人话与审批卡 describe() 逐字一致（两处叙述一个源头：目录行就是审批卡人话）
const sums = catalogSums();
for (const [action, sum] of Object.entries(sums)) {
	total++;
	const ok = describe(action, null) === sum;
	if (ok) pass++;
	if (!ok) console.log(`  describe(${action})=${JSON.stringify(describe(action, null))} vs catalog=${JSON.stringify(sum)}`);
	console.log(`${ok ? "PASS" : "FAIL"}: 写面人话一致 ${action}`);
}

// 4) 每个目录动作的分层标记与 classify() 同源（渲染现算，此处验渲染器没自作聪明）
const text = bridgeCatalogText();
for (const name of catalogNames) {
	total++;
	const tier = classify(name);
	const ok = new RegExp(`- ${name}\\{[^}]*\\}[^\\n]*\\[${tier}\\]`).test(text);
	if (ok) pass++;
	if (!ok) console.log(`  渲染行缺失或分层不符: ${name} 期望 [${tier}]`);
	console.log(`${ok ? "PASS" : "FAIL"}: 目录行含分层标记 ${name} [${tier}]`);
}

// 5) 渲染文本自带计数且自洽（description 首行声称的数目 = 实际行数）
const claimed = Number(text.match(/共 (\d+) 个/)?.[1] ?? 0);
check(`首行计数自洽（声称 ${claimed} = 实际 ${catalogNames.length}）`, claimed === catalogNames.length);

process.exit(pass === total ? 0 : 1);
