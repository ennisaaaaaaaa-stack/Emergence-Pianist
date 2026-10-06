// 自学习闭环 v2 第一铲测试：skill-gate 四道闸 + classify 降档 + 壳侧端到端（mock Grimoire 不真打山海）
// 验证链：
//   1. 四道闸独立打回：每闸一个只违反该闸的 payload，reasons 含闸号关键词，其余三闸全过
//   2. 非 auto/ 名字：四闸全跳过（body 全是 AKIA 密钥形状也放行——有意行为，钉死防「顺手加固」破坏 retropad 现状）
//   3. 边界：name="auto/"（空前缀无名字）、trigger 恰 4 词 / 恰 5 词、control_case 空串 vs 缺字段
//   4. classify 降档：auto/+双条件→amber；auto/+伪造 _gate_pass（壳外直调）→red；非 auto→red 不变
//   5. 壳侧端到端：闸红→422 reasons 逐条 + mock 零转发；闸绿→转发发生且 payload 带 _gate_pass
//   6. retropad 形状（非 auto 名字、trigger 空串）行为不变：red 挂起 deferred，不转发
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { classify } from "../src/queue-core.mjs";
import { isAutoSubmission, validateSkillSubmission } from "../src/skill-gate.mjs";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pianist-skillgate-"));
let pass = 0, total = 0;
function check(name, ok) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}`); }

/** 全绿基线 payload：四闸全过（后续每闸只拧一个字段变红） */
function greenPayload() {
	return {
		name: "auto/test-skill",
		tags: ["self-learning"],
		body: "正文：把这次的坑记成书。",
		trigger: "坑 记 书",
		boundary: "只管本仓的坑",
		why: "少踩一遍",
		control_case: "别的仓的坑不该触发本 skill",
	};
}

// ---------------------------------------------------------------------------
// 1) 四道闸独立打回
// ---------------------------------------------------------------------------

// 闸一：tags 空数组（body/trigger/消毒/词数/反例全过）
{
	const p = { ...greenPayload(), tags: [] };
	const v = validateSkillSubmission(p);
	check("闸一 tags 空数组 → 打回", v.ok === false);
	check("闸一 理由含「闸一」", v.reasons.some((r) => r.includes("闸一") && r.includes("tags")));
	check("闸一 只打这一条（其余三闸过）", v.reasons.length === 1 && !v.reasons.some((r) => r.includes("闸二") || r.includes("闸三") || r.includes("闸四")));
}
{
	const p = { ...greenPayload(), body: "   " };
	const v = validateSkillSubmission(p);
	check("闸一 body 纯空白 → 打回", v.ok === false && v.reasons.some((r) => r.includes("闸一") && r.includes("body")));
}
{
	const p = { ...greenPayload(), trigger: "" };
	const v = validateSkillSubmission(p);
	check("闸一 trigger 空串 → 打回（retropad 形状在 auto/ 名下也会被闸一拦）", v.ok === false && v.reasons.some((r) => r.includes("闸一") && r.includes("trigger")));
}
{
	const p = { ...greenPayload(), tags: "self-learning" }; // 非数组
	const v = validateSkillSubmission(p);
	check("闸一 tags 非数组 → 打回", v.ok === false && v.reasons.some((r) => r.includes("闸一") && r.includes("tags")));
}

// 闸二：消毒——五种形状各打一遍（其余三闸全过）
{
	const secrets = [
		["AWS", "泄漏 AKIAIOSFODNN7EXAMPLE 在正文"],
		["PEM", "-----BEGIN RSA PRIVATE KEY-----"],
		["sk-", "key 是 sk-abc123XYZdef456GHIjkl"],
		["ghp_", "token ghp_0123456789abcdefghijklmnopqrstuvwx"],
		["root", "配置在 /root/Agent-Grimoire/grimoire.py"],
	];
	for (const [label, dirty] of secrets) {
		const p = { ...greenPayload(), body: dirty };
		const v = validateSkillSubmission(p);
		check(`闸二 消毒命中（${label}）→ 打回`, v.ok === false);
		check(`闸二 理由含「闸二」+命中片段（${label}）`, v.reasons.some((r) => r.includes("闸二") && r.length > 10));
		check(`闸二 只打消毒这一条（${label}）`, v.reasons.length === 1 && v.reasons[0].includes("闸二"));
	}
	// 四字段拼接面：秘密藏在 why/boundary/trigger 任一处都拦
	{
		const p = { ...greenPayload(), why: "路径在 /root/secrets/ 里" };
		const v = validateSkillSubmission(p);
		check("闸二 why 字段藏 /root/ → 打回", v.ok === false && v.reasons.some((r) => r.includes("闸二")));
	}
	{
		const p = { ...greenPayload(), boundary: "边界：AKIAIOSFODNN7EXAMPLE 不许出现" };
		const v = validateSkillSubmission(p);
		check("闸二 boundary 字段藏 AKIA → 打回", v.ok === false && v.reasons.some((r) => r.includes("闸二")));
	}
}

// 闸三：触发词 N≥5 打回（判而不剪——理由带修剪纪律原文）
{
	const p = { ...greenPayload(), trigger: "一 二 三 四 五" };
	const v = validateSkillSubmission(p);
	check("闸三 trigger 5 词 → 打回", v.ok === false);
	check("闸三 理由含「闸三」+修剪纪律", v.reasons.some((r) => r.includes("闸三") && r.includes("1-3 全留 / 4 留 3 / ≥5 只留 4")));
	check("闸三 判而不剪（只打这一条）", v.reasons.length === 1);
}

// 闸四：control_case 缺失（其余三闸全过）
{
	const p = greenPayload();
	delete p.control_case;
	const v = validateSkillSubmission(p);
	check("闸四 control_case 缺字段 → 打回", v.ok === false);
	check("闸四 理由含「闸四」", v.reasons.some((r) => r.includes("闸四") && r.includes("control_case")));
	check("闸四 只打这一条", v.reasons.length === 1);
}

// ---------------------------------------------------------------------------
// 2) 非 auto/ 名字：四闸全跳过（钉死——防未来「顺手加固」把非 auto 也拦了破坏 retropad）
// ---------------------------------------------------------------------------

{
	// body 全是 AKIA 密钥形状 + trigger 空串 + 无 control_case——非 auto 名字照样放行，
	// 这是拍板边界：非 auto 走 red 人工审批面，人眼兜底
	const p = {
		name: "test-skill", // retropad 现有形状：无 auto/ 前缀
		tags: [],
		body: "AKIAIOSFODNN7EXAMPLE 谁看谁尴尬 -----BEGIN RSA PRIVATE KEY-----",
		trigger: "",
		boundary: "",
		why: "sk-abc123XYZdef456GHIjkl",
	};
	const v = validateSkillSubmission(p);
	check("非 auto/ 名字：满身秘密形状也放行（red 人眼兜底）", v.ok === true);
	check("isAutoSubmission: 非 auto 前缀 → false", isAutoSubmission(p) === false);
	check("classify: 非 auto + 伪造 _gate_pass → red", classify("grimoire_submit", { ...p, _gate_pass: true }) === "red");
}

// ---------------------------------------------------------------------------
// 3) 边界
// ---------------------------------------------------------------------------

{
	// name="auto/"（空前缀无名字）：字面非空 + auto/ 前缀 → 闸生效（字段缺失会被闸一拦）
	const p = { ...greenPayload(), name: "auto/" };
	check("边界 name='auto/'：算 auto（isAutoSubmission true）", isAutoSubmission(p) === true);
	const bad = { ...p, tags: [] };
	const v = validateSkillSubmission(bad);
	check("边界 name='auto/' + tags 空 → 闸一生效打回", v.ok === false && v.reasons.some((r) => r.includes("闸一")));
	const ok = validateSkillSubmission(p);
	check("边界 name='auto/' + 字段全绿 → 放行（名字本身不另设闸）", ok.ok === true);
	check("边界 ' auto/x '（带空格）trim 后算 auto", isAutoSubmission({ name: " auto/x " }) === true);
	check("边界 'auto-x'（连字符非斜杠）不算 auto", isAutoSubmission({ name: "auto-x" }) === false);
}
{
	// trigger 恰 4 词 → 过闸三；恰 5 词 → 打回
	const p4 = { ...greenPayload(), trigger: "一 二 三 四" };
	check("边界 trigger 恰 4 词 → 放行", validateSkillSubmission(p4).ok === true);
	const p5 = { ...greenPayload(), trigger: "一 二 三 四 五" };
	check("边界 trigger 恰 5 词 → 打回", validateSkillSubmission(p5).ok === false);
}
{
	// control_case 空串 vs 缺字段：同样打回
	const e = { ...greenPayload(), control_case: "" };
	check("边界 control_case 空串 → 打回", validateSkillSubmission(e).ok === false && validateSkillSubmission(e).reasons.some((r) => r.includes("闸四")));
	const w = { ...greenPayload(), control_case: "   " };
	check("边界 control_case 纯空白 → 打回", validateSkillSubmission(w).ok === false);
}
{
	// 全绿基线自检
	const v = validateSkillSubmission(greenPayload());
	check("基线 payload 四闸全过", v.ok === true);
	// 多闸同红：reasons 逐条都在
	const p = greenPayload();
	delete p.tags; delete p.control_case; p.body = "key /root/x";
	const v2 = validateSkillSubmission(p);
	check("多闸同红 → reasons 逐条（闸一+闸二+闸四 三条都在）",
		v2.ok === false
		&& v2.reasons.some((r) => r.includes("闸一"))
		&& v2.reasons.some((r) => r.includes("闸二"))
		&& v2.reasons.some((r) => r.includes("闸四")));
}

// ---------------------------------------------------------------------------
// 4) classify 降档（壳外直调 classify 单元面）
// ---------------------------------------------------------------------------

check("classify: auto/ + _gate_pass + 有效 payload → amber", classify("grimoire_submit", { ...greenPayload(), _gate_pass: true }) === "amber");
check("classify: auto/ + 无 _gate_pass → red（标记必须壳侧注入）", classify("grimoire_submit", greenPayload()) === "red");
check("classify: auto/ + 伪造 _gate_pass + 无效 payload → red（双条件堵伪造）", classify("grimoire_submit", { ...greenPayload(), trigger: "一 二 三 四 五", _gate_pass: true }) === "red");
check("classify: auto/ + _gate_pass 假值（'true' 字符串）→ red", classify("grimoire_submit", { ...greenPayload(), _gate_pass: "true" }) === "red");
check("classify: 非 auto（retropad 形状 name+trigger 空串）→ red 不变", classify("grimoire_submit", { name: "test-skill", tags: ["self-learning"], body: "x", trigger: "", boundary: "", why: "" }) === "red");
check("classify: grimoire_submit 空载荷 → red（原行为）", classify("grimoire_submit", {}) === "red");
check("classify: 其他动作不受影响（bash rm -rf → red）", classify("bash", { command: "rm -rf /tmp/x" }) === "red");
check("classify: 其他动作不受影响（grimoire_map → silent）", classify("grimoire_map", {}) === "silent");

// ---------------------------------------------------------------------------
// 5) 壳侧端到端（真壳 + mock Grimoire HTTP——不真打山海）
// ---------------------------------------------------------------------------

const grimoirePosts = [];
const mockGrimoire = http.createServer((req, res) => {
	const chunks = [];
	req.on("data", (c) => chunks.push(c));
	req.on("end", () => {
		if (req.method === "POST") grimoirePosts.push({ path: req.url, body: Buffer.concat(chunks).toString("utf8") });
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, mock: true }));
	});
});
await new Promise((ok) => mockGrimoire.listen(0, "127.0.0.1", ok));
const grimoirePort = mockGrimoire.address().port;

const shellPort = 41900 + Math.floor(Math.random() * 90); // 随机高位口：防上一轮泄漏进程占死固定口（真壳生产实例在 8770，不碰）
const shellProc = spawn("node", ["src/shell.mjs"], {
	stdio: ["ignore", "pipe", "pipe"],
	env: {
		...process.env,
		PIANIST_SHELL_PORT: String(shellPort),
		GRIMOIRE_URL: `http://127.0.0.1:${grimoirePort}`,
		PIANIST_TELEMETRY_DIR: path.join(tmpDir, "tel"),
		PIANIST_AUDIT_FILE: path.join(tmpDir, "audit.jsonl"),
	},
});
await new Promise((r) => setTimeout(r, 800));
const shellUrl = `http://127.0.0.1:${shellPort}`;
// 兜底清扫：中途断言崩溃也不许泄漏壳进程（上一轮撞过坑）
process.on("exit", () => { try { shellProc.kill(); } catch {} try { mockGrimoire.close(); } catch {} });

async function invoke(action, payload, agent = "skillgate-test") {
	const res = await fetch(`${shellUrl}/tools/invoke`, {
		method: "POST", headers: { "content-type": "application/json" },
		body: JSON.stringify({ action, payload, agent, intent: "skill-gate 测试" }),
	});
	return res.json();
}

// 闸红 → 422 + mock 零转发（验收 A：auto/ 违闸提交拿不到山海转发）
{
	const before = grimoirePosts.length;
	const out = await invoke("grimoire_submit", { ...greenPayload(), body: "泄漏 AKIAIOSFODNN7EXAMPLE" });
	check("e2e 闸红 → 返回 422 形状", out.status === 422 && out.body?.ok === false);
	check("e2e 闸红 → reasons 逐条人话（含闸二）", Array.isArray(out.body?.reasons) && out.body.reasons.every((r) => typeof r === "string") && out.body.reasons.some((r) => r.includes("闸二")));
	check("e2e 闸红 → 山海转发零调用", grimoirePosts.length === before);
	check("e2e 闸红 → 不挂审批不 deferred", out.deferred !== true);
}
{
	// 四闸同红的 auto/ 提交同样零转发
	const before = grimoirePosts.length;
	const out = await invoke("grimoire_submit", { name: "auto/bad", tags: [], body: "", trigger: "一 二 三 四 五" });
	check("e2e 四闸同红 → 422 且 reasons ≥4 条", out.status === 422 && out.body?.reasons?.length >= 4);
	check("e2e 四闸同红 → 零转发", grimoirePosts.length === before);
}
// 闸绿 → 转发发生且 payload 带 _gate_pass（amber 路直走）
{
	const before = grimoirePosts.length;
	const out = await invoke("grimoire_submit", greenPayload());
	check("e2e 闸绿 → 转发发生（mock 收到 POST /skill）", grimoirePosts.length === before + 1 && grimoirePosts[grimoirePosts.length - 1].path === "/skill");
	const sent = grimoirePosts.length > before ? JSON.parse(grimoirePosts[grimoirePosts.length - 1].body) : null;
	check("e2e 闸绿 → 转发 payload 带 _gate_pass: true", sent?._gate_pass === true && sent?.name === "auto/test-skill");
	check("e2e 闸绿 → 走 amber 直通不挂审批", out?.status === 200 && out.deferred !== true);
}
// retropad 形状（非 auto 名字、trigger 空串）→ red 挂起 deferred，不转发（验收 B：行为不变）
{
	const before = grimoirePosts.length;
	const out = await invoke("grimoire_submit", {
		name: "test-skill", tags: ["self-learning"], body: "正文", trigger: "", boundary: "", why: "", author: "retropad-1", source: "self",
	}, "retropad-1");
	check("e2e retropad 形状 → red 挂起 deferred（原行为）", out.deferred === true && typeof out.approval?.id === "string");
	check("e2e retropad 形状 → 不转发", grimoirePosts.length === before);
}

shellProc.kill();
mockGrimoire.close();
fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
