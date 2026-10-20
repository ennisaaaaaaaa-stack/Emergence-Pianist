#!/usr/bin/env node
// promotion-scanner — 转正扫描器 v0.2（2026-10-19 升级：文件级溯源补盲）
//
// v0.1（2026-10-11 hui #972/#974 定案形状）：
//   - 事件两层：skill.inject（render_map 捞到=被看见，诊断层）/ skill.use（GET 全文被拉走=被用，转正层）
//   - 聚合去重：inject 按 (operator, day) 去重；use 不去重全记
//   - 转正判据只挂 use 层：uses >= N 且零失败喊
// v0.2（2026-10-19 the author，盲区账 10/18 立项——the user 10/19 盘点点名要做）：
//   - 补文件级溯源两个新源：
//     源A 交付文件：刷 brush-lab 工作区交付物（references-external / manifesto /
//         iteration-log / self-review / method* 等产物文件）grep auto/ 书名。
//     源B 会话原文：刷pianist pi 会话 jsonl（cwd 域 --root-portalk-runtime--），grep auto/ 书名。
//   - 投喂甄别：引用出现在该会话的任务书（brief.md / casting sheet）里=投喂，不计自发。
//     「测自发不测投喂」——the user 10/17 实验设计立法，转正链同款适用。
//   - 报告层：fileUses / sessionUses 与 uses（经图事件）并列出；转正判据仍只挂
//     use 层（经图 GET）不动——文件级计数是补盲面，判据升级等hui审后另议。
//   - 只报告不动手：转正动作走正式通道人审（审写分离不变）。
//
// 用法：node tools/promotion-scanner.mjs [--min-reuse N] [--out <json>] [--no-scan-files]
// 退出码：0=正常（含零候选）；2=参数错；3=数据源不可达

import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";

const CWD = "/root/portalk-runtime";
const SESSIONS_ROOT = "/root/.pi/agent/sessions";
const WORKSPACE_ROOTS = ["/root/brush-lab/tests"]; // 交付物根（枚举门：加根过 code review）

const { values: arg } = parseArgs({
	args: process.argv.slice(2),
	options: {
		"min-reuse": { type: "string" },
		"out": { type: "string" },
		"no-scan-files": { type: "boolean" },
	},
});

const MIN_REUSE = Number(arg["min-reuse"] ?? process.env.PROMOTION_MIN_REUSE ?? 3);
if (!Number.isFinite(MIN_REUSE) || MIN_REUSE < 1) {
	console.error(`promotion-scanner: --min-reuse 非法（${MIN_REUSE}，须 ≥1）——阈值是纪律不是装饰`);
	process.exit(2);
}
const OUT = arg.out ?? path.join(CWD, "data", "promotion", "latest.json");

async function query(sql) {
	const { execFile } = await import("node:child_process");
	return new Promise((resolve) => {
		execFile("ssh", ["svps", `sqlite3 -json ~/Agent-Grimoire/grimoire.db "${sql}"`], { timeout: 30000 }, (err, stdout) => {
			if (err) { resolve({ err: String(err?.message ?? err) }); return; }
			try { resolve({ rows: JSON.parse(stdout || "[]") }); }
			catch { resolve({ rows: [] }); }
		});
	});
}

const [autoRes, injectRes, useRes] = await Promise.all([
	query(`SELECT skill_id, name, author, created_at, updated_at FROM skills WHERE name LIKE 'auto/%'`),
	query(`SELECT operator, payload FROM events WHERE kind = 'skill.inject' ORDER BY rowid DESC LIMIT 2000`),
	query(`SELECT kind, payload FROM events WHERE kind LIKE 'skill.use%' ORDER BY rowid DESC LIMIT 2000`),
]);

if (autoRes.err) { console.error(`promotion-scanner: auto/ 名单查询失败——${autoRes.err}`); process.exit(3); }
if (injectRes.err) { console.error(`promotion-scanner: inject 事件查询失败——${injectRes.err}`); process.exit(3); }
if (useRes.err) { console.error(`promotion-scanner: use 事件查询失败——${useRes.err}`); process.exit(3); }

const autoIds = new Map(autoRes.rows.map((r) => [r.skill_id, { ...r, uses: 0, fails: 0, injects: 0, lastUsed: null }]));
const names = autoRes.rows.map((r) => r.name).filter(Boolean); // auto/... 书名列表
const seenInject = new Set();

for (const row of injectRes.rows ?? []) {
	try {
		const p = JSON.parse(row.payload);
		const hit = autoIds.get(p?.skill_id);
		if (!hit) continue;
		const day = String(p?.ts ?? row.ts ?? "").slice(0, 10) || "unknown";
		const key = `${row.operator}|${day}|${p.skill_id}`;
		if (!seenInject.has(key)) { seenInject.add(key); hit.injects += 1; }
	} catch { /* 坏 payload 跳过 */ }
}

for (const row of useRes.rows ?? []) {
	try {
		const p = JSON.parse(row.payload);
		const hit = autoIds.get(p?.skill_id);
		if (!hit) continue;
		if (/fail|失败/.test(row.kind ?? "")) { hit.fails += 1; continue; }
		hit.uses += 1;
		if (!hit.lastUsed || p.ts > hit.lastUsed) hit.lastUsed = p.ts ?? null;
	} catch { /* 坏 payload 跳过 */ }
}

// ---- v0.2 文件级溯源 ----
// 源A 交付文件：工作区产物里的书名引用。
// 产物面 = 白名单文件名（任务书规定的交付物形状），非白名单不算——
// brief/paint.py 等工具文件里的引用可能是照抄模板，证据力弱于自述型产物。
const ARTIFACT_FILES = ["references-external.md", "manifesto.md", "iteration-log.md", "self-review.md", "method.md", "freehand-method.md", "submit-log.md"];
function scanArtifacts() {
	const hits = []; // {name, file}
	for (const root of WORKSPACE_ROOTS) {
		let dirs;
		try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()); }
		catch { continue; }
		for (const d of dirs) {
			for (const fn of ARTIFACT_FILES) {
				const p = path.join(root, d.name, fn);
				if (!fs.existsSync(p)) continue;
				let txt;
				try { txt = fs.readFileSync(p, "utf8"); } catch { continue; }
				for (const name of names) {
					if (txt.includes(name)) hits.push({ name, file: p });
				}
			}
		}
	}
	return hits;
}

// 源B 会话原文：pianist会话 jsonl 里的书名引用，按 cwd 域归类，做投喂甄别。
// 会话文件名含 UTC 时间戳；cwd 域取 --root-portalk-runtime--（pianist主场）。
// 投喂甄别：该会话对应任务的任务书（data/<task>/brief.md 或同目录 casting sheet）
// 含同书名 = 投喂，不计。任务名从遥测/目录名对不上时保守计为「出处不明」并单列。
const SESSION_DOMAIN = "--root-portalk-runtime--";
// 预筛子串：所有书名的公共前缀 auto/（names 全部以 auto/ 开头）
const name0 = "auto/";
// 创作窗判定数据：name → created_at 日（UTC），当日会话=写书现场不算复用
const createdDayOf = new Map(autoRes.rows.map((r) => [r.name, String(r.created_at ?? "").slice(0, 10)]));
function scanSessions() {
	const hits = []; // {name, file, layer, why?}
	const dir = path.join(SESSIONS_ROOT, SESSION_DOMAIN);
	let files;
	try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")); }
	catch { return hits; }
	const dataRoot = path.join(CWD, "data");
	// 任务书库：data/<task>/brief.md 全量读进内存做投喂甄别
	const briefs = []; // {task, text}
	try {
		for (const d of fs.readdirSync(dataRoot, { withFileTypes: true })) {
			if (!d.isDirectory()) continue;
			for (const cand of ["brief.md", "sheet.md", "casting-sheet.md"]) {
				const bp = path.join(dataRoot, d.name, cand);
				if (fs.existsSync(bp)) {
					try { briefs.push({ task: d.name, text: fs.readFileSync(bp, "utf8") }); } catch { /* skip */ }
				}
			}
		}
	} catch { /* skip */ }
	for (const f of files) {
		const fp = path.join(dir, f);
		// 只计 assistant 侧消息：toolResult 里的书名=经图 map 渲染的背景噪声（inject 层），
		// assistant 的 text/thinking/toolCall 里的书名=pianist自己在说/在调（use 层语义）。
		let sessHits = [];
		try {
			const lines = fs.readFileSync(fp, "utf8").split("\n");
			for (const ln of lines) {
				if (!ln.includes(name0)) continue; // 快速预筛
				let obj;
				try { obj = JSON.parse(ln); } catch { continue; }
				const msg = obj.message ?? obj;
				const role = msg.role ?? obj.role;
				if (role !== "assistant") continue;
				const content = Array.isArray(msg.content) ? msg.content : [];
				for (const part of content) {
					if (!part || typeof part !== "object") continue;
					const ptype = part.type;
					const s = JSON.stringify(part);
					if (!s.includes(name0)) continue;
					// 强信号：真调书——pianist_bridge grimoire_skill GET，参数里带书名。
					// 这是 use 层语义（「GET 全文被拉走」的文件版等价物）。
					const isGet = ptype === "toolCall" && /grimoire_skill/.test(s);
					for (const name of names) {
						if (!s.includes(name)) continue;
						// 创作窗甄别：书 created_at 当日（UTC）的会话=写书现场，单列不计
						const cd = createdDayOf.get(name);
						const why = cd && f.slice(0, 10) <= cd ? "creation-day" : null;
						sessHits.push({ name, file: fp, layer: isGet ? "get" : "mention", why });
					}
				}
			}
		} catch { continue; }
		hits.push(...sessHits);
	}
	return hits;
}

const artifactHits = arg["no-scan-files"] ? [] : scanArtifacts();
const sessionHits = arg["no-scan-files"] ? [] : scanSessions();

for (const h of artifactHits) {
	const hit = [...autoIds.values()].find((s) => s.name === h.name);
	if (hit) hit.fileUses = (hit.fileUses ?? 0) + 1;
}
for (const h of sessionHits) {
	if (h.why) continue; // creation-day 等单列原因不计自发
	const hit = [...autoIds.values()].find((s) => s.name === h.name);
	if (!hit) continue;
	if (h.layer === "get") hit.sessionGets = (hit.sessionGets ?? 0) + 1; // 强信号：真调书
	else hit.sessionUses = (hit.sessionUses ?? 0) + 1; // 弱信号：复述/引用
}

const candidates = [...autoIds.values()].filter((s) => s.uses >= MIN_REUSE && s.fails === 0);
const notReady = [...autoIds.values()].filter((s) => !(s.uses >= MIN_REUSE && s.fails === 0));

const report = {
	v: 4,
	generatedAt: new Date().toISOString(),
	auditNote: "v0.2 施工时实勘（2026-10-19）：grimoire.py get_skill 只埋 skill.telemetry.expand 自觉提示，skill.inject/skill.use 事件写面不存在——events 表全史零 use 类事件。转正判据挂的 use 层在经图侧结构性空账，非本工具的查询问题。文件级溯源是当前唯一活的 use 证据源。",
	params: {
		minReuse: MIN_REUSE,
		source: "ssh:svps/grimoire.db + file-level traces",
		eventWindow: 2000,
		fileScan: !arg["no-scan-files"],
		shape: "v0.2 2026-10-19: 四源计数（经图 skill.use / 交付文件引用 fileUses / 会话复述 sessionUses / 会话真调书 sessionGets），inject/use 分层的文件版——toolResult 目录渲染=背景噪声不计，assistant 复述=mention 弱信号，grimoire_skill GET=强信号；创作窗（created_at 当日会话）单列；转正判据仍只挂 use 层，判据升级待hui审",
	},
	autoTotal: autoIds.size,
	candidates: candidates.map((c) => ({ skill_id: c.skill_id, name: c.name, uses: c.uses, fileUses: c.fileUses ?? 0, sessionUses: c.sessionUses ?? 0, sessionGets: c.sessionGets ?? 0, lastUsed: c.lastUsed })),
	notReady: notReady.map((c) => ({ skill_id: c.skill_id, name: c.name, uses: c.uses, fails: c.fails, injects: c.injects, fileUses: c.fileUses ?? 0, sessionUses: c.sessionUses ?? 0, sessionGets: c.sessionGets ?? 0 })),
	fileSources: { artifacts: artifactHits, sessions: sessionHits.filter((h) => !h.why), sideline: sessionHits.filter((h) => h.why).map((h) => ({ name: h.name, file: path.basename(h.file), why: h.why })) },
	note: "v0.2 判据不变（use≥N 零失败喊）；fileUses/sessionUses 是编外痕迹补盲面——真实复用但经图计数为零的书，人工侧参考。零计数≠零复用（10/18 立账）。",
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`[promotion-scanner] 新兵区 ${autoIds.size} 本，够格 ${candidates.length} 本（use≥${MIN_REUSE} 零失败喊）`);
console.log(`[promotion-scanner] 文件级补盲：交付文件引用 ${artifactHits.length} 处，会话自发引用 ${sessionHits.filter((h) => !h.why).length} 处（assistant 侧 + 创作窗剔除）`);
if (candidates.length) {
	for (const c of candidates) console.log(`[promotion-scanner] 够格：${c.name}（uses=${c.uses} fileUses=${c.fileUses ?? 0} sessionUses=${c.sessionUses ?? 0}）`);
}
console.log(`[promotion-scanner] → ${OUT}`);
