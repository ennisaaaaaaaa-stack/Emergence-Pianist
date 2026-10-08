#!/usr/bin/env node
// 恢复器 B 件：pi 会话 jsonl → 机械重放「写文件类」工具调用，恢复工作区。
// 诞生背景：10/8 审批单复验现场 `git checkout -- .` 误清未 commit 的pianist施工（6 文件），
// 靠 pi 会话原文手工重放 43 个工具调用救回（package.json blob hash 逐字节对上施工版）。
// 本工具把该手工流程机械化。配套 A 件 prespawn-snapshot.mjs（发车前快照兜底）。
//
// pi 会话 jsonl 解析事实（10/8 实战验证过，照抄别再探）：
//   - 每行一个 JSON 对象，顶层 type:'message'
//   - 工具调用在 message.content 数组里：{type:'toolCall', name, arguments}（键名是 arguments 不是 input）
//   - write 工具 arguments 形状：{path, content}（整文件覆盖）
//   - edit 工具 arguments 形状：{path, edits:[{oldText, newText}]}
//   - 重放严格按会话顺序 apply——后续 edit 的锚在前面 edit 的产物上，乱序必锚不中
//
// 已知限制（设计接受，不在此解决）：
//   - JSON 文件上做 edit 锚替换天然脆（oldText 稍有出入即 miss）
//   - bash 调用里的写文件不可重放（bash 调用一律跳过，进不可重放清单）
//   - 重放不幂等：同一会话二次 --apply 时，已应用的 edit 会锚 miss（会失败停滚，不会写坏盘上内容）
//
// 安全设计：
//   - 默认 dry-run（只报告不写盘），--apply 才写
//   - 写模式路径白名单 = 工作区（--cwd，默认 process.cwd()）子树 + /tmp；
//     越界路径只列入「待人工确认」清单，绝不自动写
//   - edit 锚 miss → 该文件后续 edit 停滚（防错位半写），其他文件继续
//   - 单次 edit 调用内多组 {oldText,newText} 原子应用：任一锚 miss 则整条调用不动文件
//
// 用法：
//   node scripts/recover-workspace.mjs <session.jsonl>            # dry-run，只报告
//   node scripts/recover-workspace.mjs <session.jsonl> --apply    # 真写盘
//   可选: --cwd <dir> 指定工作区根（默认 process.cwd()）  --json 输出 JSON 报告

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 解析：jsonl → 顺序工具调用列表
// ---------------------------------------------------------------------------

export function parseSessionToolCalls(sessionPath) {
	const raw = fs.readFileSync(sessionPath, "utf8");
	const calls = [];
	let lineNo = 0;
	for (const line of raw.split("\n")) {
		lineNo++;
		const trimmed = line.trim();
		if (!trimmed) continue;
		let obj;
		try { obj = JSON.parse(trimmed); } catch { continue; } // 非 JSON 行（会话里可能有杂行）跳过
		if (obj?.type !== "message") continue;
		const content = obj?.message?.content;
		if (!Array.isArray(content)) continue;
		for (const item of content) {
			if (item?.type !== "toolCall") continue; // text / toolResult 等不重放
			let args = item.arguments;
			if (typeof args === "string") {
				// 防御：个别序列化器把 arguments 存成 JSON 字符串
				try { args = JSON.parse(args); } catch { args = {}; }
			}
			calls.push({ lineNo, name: item.name, arguments: args ?? {} });
		}
	}
	return calls;
}

// ---------------------------------------------------------------------------
// edit 原子应用：全部锚中才替换，任一 miss 整条不动（返回原内容语义由调用方保证）
// ---------------------------------------------------------------------------

function applyEditsAtomic(content, edits) {
	if (!Array.isArray(edits) || edits.length === 0) {
		return { ok: false, reason: "edits 为空或非数组" };
	}
	let work = content;
	for (const e of edits) {
		const { oldText, newText } = e ?? {};
		if (typeof oldText !== "string" || typeof newText !== "string") {
			return { ok: false, reason: "oldText/newText 缺失或非字符串" };
		}
		const first = work.indexOf(oldText);
		if (first === -1) {
			return { ok: false, reason: `oldText 未找到（片段: ${JSON.stringify(oldText.slice(0, 60))}）` };
		}
		if (work.indexOf(oldText, first + 1) !== -1) {
			return { ok: false, reason: `oldText 出现多次、非唯一锚（片段: ${JSON.stringify(oldText.slice(0, 60))}）` };
		}
		work = work.slice(0, first) + newText + work.slice(first + oldText.length);
	}
	return { ok: true, content: work };
}

// ---------------------------------------------------------------------------
// 路径白名单：工作区子树 + /tmp
// ---------------------------------------------------------------------------

function makePathGuard(root) {
	const tmpRoot = "/tmp";
	return function guard(p) {
		if (typeof p !== "string" || p === "") {
			return { ok: false, abs: String(p), malformed: true, reason: "path 缺失或非字符串" };
		}
		const abs = path.resolve(root, p);
		const allowed =
			abs === root || abs.startsWith(root + path.sep) ||
			abs === tmpRoot || abs.startsWith(tmpRoot + path.sep);
		return { ok: allowed, abs, malformed: false, reason: allowed ? null : `越界（白名单=${root} 子树 + /tmp）` };
	};
}

function sha256(str) {
	return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// 核心：重放。返回结构化报告（不打印、不退出——CLI 与测试共用）
// ---------------------------------------------------------------------------

export function recoverWorkspace({ sessionPath, root = process.cwd(), apply = false }) {
	root = path.resolve(root);
	const calls = parseSessionToolCalls(sessionPath);
	const guard = makePathGuard(root);

	const report = {
		mode: apply ? "apply" : "dry-run",
		root,
		sessionPath,
		calls: [],        // 逐调用 applied / failed / skipped / needs-manual
		files: [],        // 每目标文件 sha256（dry-run 为预期恢复态，apply 为写盘态）
		nonReplayable: [], // bash 等含副作用、不可机械重放的调用
		manualReview: [], // 越界路径，待人工确认
		summary: null,
	};

	const mem = new Map();     // absPath → 当前内容（磁盘态 + 已重放产物叠加）
	const poisoned = new Set(); // 锚 miss 后停滚的文件

	function loadCurrent(abs) {
		if (mem.has(abs)) return { ok: true, content: mem.get(abs) };
		if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
			return { ok: true, content: fs.readFileSync(abs, "utf8") };
		}
		return { ok: false, reason: "目标文件不存在（磁盘与重放产物均无，edit 无锚可依）" };
	}

	function writeOut(abs, content) {
		if (!apply) return;
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content, "utf8");
	}

	for (let i = 0; i < calls.length; i++) {
		const call = calls[i];
		const seq = i + 1;
		const name = call.name;
		const args = call.arguments ?? {};

		if (name === "write") {
			const g = guard(args.path);
			if (g.malformed) {
				report.calls.push({ seq, tool: "write", path: g.abs, status: "skipped", note: g.reason });
				continue;
			}
			if (!g.ok) {
				report.calls.push({ seq, tool: "write", path: g.abs, status: "needs-manual", note: g.reason + "，待人工确认，不自动写" });
				report.manualReview.push({ seq, tool: "write", path: g.abs });
				continue;
			}
			if (poisoned.has(g.abs)) {
				report.calls.push({ seq, tool: "write", path: g.abs, status: "skipped", note: "该文件已停滚（先前 edit 锚 miss），防错位半写" });
				continue;
			}
			if (typeof args.content !== "string") {
				report.calls.push({ seq, tool: "write", path: g.abs, status: "failed", note: "content 缺失或非字符串" });
				continue;
			}
			mem.set(g.abs, args.content);
			writeOut(g.abs, args.content);
			report.calls.push({
				seq, tool: "write", path: g.abs, status: "applied",
				note: apply ? `已写盘 ${Buffer.byteLength(args.content)}B` : `将写盘 ${Buffer.byteLength(args.content)}B（dry-run 未写）`,
			});
			continue;
		}

		if (name === "edit") {
			const g = guard(args.path);
			if (g.malformed) {
				report.calls.push({ seq, tool: "edit", path: g.abs, status: "skipped", note: g.reason });
				continue;
			}
			if (!g.ok) {
				report.calls.push({ seq, tool: "edit", path: g.abs, status: "needs-manual", note: g.reason + "，待人工确认，不自动写" });
				report.manualReview.push({ seq, tool: "edit", path: g.abs });
				continue;
			}
			if (poisoned.has(g.abs)) {
				report.calls.push({ seq, tool: "edit", path: g.abs, status: "skipped", note: "该文件已停滚（先前 edit 锚 miss），跳过防错位半写" });
				continue;
			}
			const cur = loadCurrent(g.abs);
			if (!cur.ok) {
				poisoned.add(g.abs);
				report.calls.push({ seq, tool: "edit", path: g.abs, status: "failed", note: `${cur.reason}（该文件后续 edit 停滚）` });
				continue;
			}
			const res = applyEditsAtomic(cur.content, args.edits);
			if (!res.ok) {
				poisoned.add(g.abs);
				report.calls.push({ seq, tool: "edit", path: g.abs, status: "failed", note: `锚 miss：${res.reason}（该文件后续 edit 停滚，停在 miss 前状态）` });
				continue;
			}
			mem.set(g.abs, res.content);
			writeOut(g.abs, res.content);
			report.calls.push({ seq, tool: "edit", path: g.abs, status: "applied", note: `${args.edits.length} 处替换全部锚中` });
			continue;
		}

		// bash 及一切非写文件类工具：不可机械重放，跳过
		const note = name === "bash"
			? "bash 调用不可机械重放（进不可重放清单）"
			: "非写文件类工具，无重放意义";
		report.calls.push({ seq, tool: name, path: args.path ?? args.command ?? "", status: "skipped", note });
		if (name === "bash") {
			report.nonReplayable.push({ seq, command: args.command ?? JSON.stringify(args).slice(0, 200) });
		}
	}

	// 汇总
	const tally = { applied: 0, failed: 0, skipped: 0, "needs-manual": 0 };
	for (const c of report.calls) tally[c.status] = (tally[c.status] ?? 0) + 1;
	report.summary = {
		total: report.calls.length,
		...tally,
		stoppedFiles: [...poisoned].sort().map((p) => path.relative(root, p) || p),
	};

	// 目标文件 sha256 清单：触达过的文件（含停滚文件——列 miss 前状态）
	const fileSet = new Set([...mem.keys(), ...poisoned]);
	for (const abs of [...fileSet].sort()) {
		let digest = null;
		if (mem.has(abs)) {
			digest = sha256(mem.get(abs)); // dry-run = 预期恢复态 hash；apply = 写盘内容 hash
		} else if (fs.existsSync(abs)) {
			digest = sha256(fs.readFileSync(abs, "utf8"));
		}
		report.files.push({
			path: abs,
			rel: path.relative(root, abs) || ".",
			sha256: digest,
			state: poisoned.has(abs)
				? (mem.has(abs) ? "stopped（锚 miss 停滚，列 miss 前状态）" : "stopped（目标缺失，未动）")
				: "recovered",
		});
	}
	return report;
}

// ---------------------------------------------------------------------------
// 报告文本
// ---------------------------------------------------------------------------

export function formatReport(report) {
	const lines = [];
	const modeTag = report.mode === "apply" ? "APPLY（已写盘）" : "DRY-RUN（未写盘，加 --apply 才写）";
	lines.push(`════ 恢复器报告 — 模式: ${modeTag} ════`);
	lines.push(`会话: ${report.sessionPath}`);
	lines.push(`工作区: ${report.root}`);
	lines.push("");
	lines.push("逐调用:");
	for (const c of report.calls) {
		const p = c.path ? path.relative(report.root, c.path) || c.path : "";
		lines.push(`  #${String(c.seq).padStart(2)} ${c.tool.padEnd(8)} ${c.status.padEnd(13)} ${p} — ${c.note}`);
	}
	lines.push("");
	const s = report.summary;
	lines.push(`汇总: 共 ${s.total} 条工具调用 — applied ${s.applied} / failed ${s.failed} / skipped ${s.skipped} / 待人工确认 ${s["needs-manual"]}`);
	if (s.stoppedFiles.length) lines.push(`停滚文件（锚 miss，停在 miss 前状态）: ${s.stoppedFiles.join(", ")}`);
	lines.push("");
	lines.push(`目标文件 sha256（${report.mode === "apply" ? "写盘态" : "预期恢复态"}）:`);
	for (const f of report.files) {
		lines.push(`  ${f.state.padEnd(30)} ${f.sha256 ?? "-".repeat(16)}  ${f.rel}`);
	}
	if (report.nonReplayable.length) {
		lines.push("");
		lines.push("不可重放清单（bash 等含副作用调用，需人工处理）:");
		for (const n of report.nonReplayable) lines.push(`  #${n.seq}  bash: ${n.command}`);
	}
	if (report.manualReview.length) {
		lines.push("");
		lines.push("待人工确认（越界路径，绝不自动写）:");
		for (const m of report.manualReview) lines.push(`  #${m.seq}  ${m.tool}: ${m.path}`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const argv = process.argv.slice(2);
	const positional = argv.filter((a) => !a.startsWith("--"));
	const flagValue = (name) => {
		const i = argv.indexOf(name);
		return i !== -1 ? argv[i + 1] : undefined;
	};
	const sessionPath = positional[0];
	if (!sessionPath) {
		console.error("用法: node scripts/recover-workspace.mjs <session.jsonl> [--apply] [--cwd <dir>] [--json]");
		process.exit(64);
	}
	if (!fs.existsSync(sessionPath)) {
		console.error(`会话文件不存在: ${sessionPath}`);
		process.exit(66);
	}
	const report = recoverWorkspace({
		sessionPath,
		root: flagValue("--cwd") ?? process.cwd(),
		apply: argv.includes("--apply"),
	});
	if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
	else console.log(formatReport(report));
	// 退出码：failed>0 → 2（部分停滚）；待人工确认>0 → 3；否则 0
	process.exit(report.summary.failed > 0 ? 2 : report.summary["needs-manual"] > 0 ? 3 : 0);
}
