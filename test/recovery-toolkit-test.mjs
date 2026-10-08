// 恢复器单（recovery-toolkit）测试：B 件 recover-workspace + A 件 prespawn-snapshot
// 覆盖验收标准全部条目（阴性对照是灵魂）：
//   行为级: fixture 会话 jsonl（真实 toolCall 形状：write + ≥2 链式 edit + bash + 锚 miss + 越界）
//           → --apply → write/链式 edit 产物与预期逐字节一致
//   阴性1: 默认 dry-run 跑完 fixture，工作区全树前后 hash 零变化
//   阴性2: 锚 miss 文件停在 miss 前状态（不半写）且报告 failed；bash 进不可重放清单且未执行
//   阴性3: 越界路径条目不写盘，报告列待人工确认
//   快照: 脏区 tar 含脏文件、不含 node_modules；干净树输出 clean 且不产 tar
//   CLI: 命令行入口真实可跑（--apply 写盘 / 默认 dry-run 不写盘 / 退出码）
// 全程 mkdtemp 隔离，不碰真工作区、不 spawn 真身进程（只 spawn 本仓短命脚本）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { recoverWorkspace, parseSessionToolCalls, formatReport } from "../scripts/recover-workspace.mjs";
import { takeSnapshot, listDirtyFiles } from "../scripts/prespawn-snapshot.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pianist-recovery-"));
process.on("exit", () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });
let pass = 0, total = 0;
function check(name, ok) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}`); }
function sha256File(p) { return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex"); }
function treeHash(root) {
	// 全树指纹：每个文件的 (相对路径, sha256) 排序拼接——内容级零变化即指纹不变
	const parts = [];
	(function walk(dir, rel) {
		for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			if (ent.name === ".git") continue;
			const r = rel ? `${rel}/${ent.name}` : ent.name;
			if (ent.isDirectory()) walk(path.join(dir, ent.name), r);
			else parts.push(`${r}:${sha256File(path.join(dir, ent.name))}`);
		}
	})(root, "");
	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// fixture：会话 jsonl（真实 toolCall 形状）+ fixture 工作区
// ---------------------------------------------------------------------------

function msg(...content) { return JSON.stringify({ type: "message", message: { role: "assistant", content } }); }
function tc(name, args) { return { type: "toolCall", name, arguments: args }; }
function text(t) { return { type: "text", text: t }; }

function buildFixture() {
	const ws = path.join(fs.mkdtempSync(path.join(tmpDir, "ws-")), "workspace");
	fs.mkdirSync(ws);
	fs.writeFileSync(path.join(ws, "anchor.md"), "orig"); // 预存文件，供锚 miss 场景
	const sessionPath = path.join(path.dirname(ws), "session.jsonl");
	const OOB = "/etc/portalk-recovery-oob-test"; // 越界路径（验收单例子 /etc/x 同型，换实际不存在的名字）
	const lines = [
		msg(text("开工（干扰项：非 toolCall 内容不重放）")),
		JSON.stringify({ type: "event", kind: "fileSnapshot", files: {} }), // 干扰项：非 message 行
		msg(tc("write", { path: "new-file.md", content: "v1 line A\n" })),          // applied
		msg(tc("edit", { path: "new-file.md", edits: [{ oldText: "line A", newText: "line A1" }] })), // 链式①
		msg(tc("edit", { path: "new-file.md", edits: [{ oldText: "A1", newText: "A2" }] })),          // 链式②（锚依赖①产物）
		msg(tc("bash", { command: "touch BASH-RAN" })),                                // skipped 不可重放
		msg(tc("edit", { path: "anchor.md", edits: [{ oldText: "orig", newText: "step1" }] })),  // applied
		msg(tc("edit", { path: "anchor.md", edits: [{ oldText: "MISSING-ANCHOR", newText: "step2" }] })), // 锚 miss → failed + 停滚
		msg(tc("edit", { path: "anchor.md", edits: [{ oldText: "step1", newText: "step3" }] })),  // 停滚 → skipped
		msg(tc("write", { path: OOB, content: "evil" })),                             // 越界 → needs-manual
	];
	fs.writeFileSync(sessionPath, lines.join("\n") + "\n");
	return { ws, sessionPath, oob: OOB };
}

// ---------------------------------------------------------------------------
// 1) 解析：toolCall 形状、顺序、干扰行过滤
// ---------------------------------------------------------------------------
{
	const { sessionPath } = buildFixture();
	const calls = parseSessionToolCalls(sessionPath);
	check("解析: toolCall 共 8 条（text/event 干扰行不计）", calls.length === 8);
	check("解析: 键名是 arguments（非 input）", calls[0].arguments?.path === "new-file.md" && typeof calls[0].arguments?.content === "string");
	check("解析: 严格按会话顺序", calls.map((c) => c.name).join(",") === "write,edit,edit,bash,edit,edit,edit,write");
}

// ---------------------------------------------------------------------------
// 2) 阴性对照 1：默认 dry-run，全树零变化
// ---------------------------------------------------------------------------
{
	const { ws, sessionPath } = buildFixture();
	const before = treeHash(ws);
	const report = recoverWorkspace({ sessionPath, root: ws, apply: false });
	check("dry-run: 模式标记 dry-run", report.mode === "dry-run");
	check("dry-run: 全树前后 hash 零变化", treeHash(ws) === before);
	check("dry-run: 新文件未落盘", !fs.existsSync(path.join(ws, "new-file.md")));
	check("dry-run: 仍产出完整逐调用报告", report.calls.length === 8 && report.calls.every((c) => typeof c.status === "string"));
	check("dry-run: 预期恢复态 sha256 已算出（new-file.md 在 files 清单）", report.files.some((f) => f.rel === "new-file.md" && /^[0-9a-f]{64}$/.test(f.sha256)));
}

// ---------------------------------------------------------------------------
// 3) 行为级：--apply 后逐字节一致 + 阴性 2（锚 miss/bash）+ 阴性 3（越界）
// ---------------------------------------------------------------------------
{
	const { ws, sessionPath, oob } = buildFixture();
	const report = recoverWorkspace({ sessionPath, root: ws, apply: true });

	// 行为级：write + 链式 edit 产物逐字节一致
	const got = fs.readFileSync(path.join(ws, "new-file.md"));
	check("apply: write+链式 edit 产物逐字节一致", Buffer.from("v1 line A2\n").equals(got));

	// 阴性 2：锚 miss 停在 miss 前状态（不半写）且报告 failed；后续 edit 停滚
	check("apply: 锚 miss 文件停在 miss 前状态（step1，不半写）", fs.readFileSync(path.join(ws, "anchor.md"), "utf8") === "step1");
	const missCall = report.calls.find((c) => c.status === "failed");
	check("apply: 锚 miss 调用报告 failed 且 note 含停滚说明", missCall?.tool === "edit" && /锚 miss/.test(missCall.note) && /停滚/.test(missCall.note));
	check("apply: 停滚后同文件后续 edit 状态 skipped", report.calls[6].status === "skipped" && /停滚/.test(report.calls[6].note));

	// 阴性 2：bash 跳过且未执行
	check("apply: bash 未执行（marker 未产生）", !fs.existsSync(path.join(ws, "BASH-RAN")));
	const bashCall = report.calls.find((c) => c.tool === "bash");
	check("apply: bash 调用进 skipped", bashCall?.status === "skipped");
	check("apply: bash 进不可重放清单（含命令原文）", report.nonReplayable.length === 1 && report.nonReplayable[0].command === "touch BASH-RAN");

	// 阴性 3：越界路径不写盘、报告待人工确认
	const oobLeak = fs.existsSync(oob);
	check("apply: 越界路径未写盘", !oobLeak);
	if (oobLeak) fs.rmSync(oob); // 防御清理：突变窗内被真写入时清掉，防污染下一轮（10/8 突变复验实录）
	check("apply: 越界条目状态 needs-manual", report.calls[7].status === "needs-manual");
	check("apply: 越界条目进待人工确认清单", report.manualReview.length === 1 && report.manualReview[0].path === oob);

	// 汇总数字
	check("apply: 汇总 applied 4 / failed 1 / skipped 2 / needs-manual 1",
		report.summary.applied === 4 && report.summary.failed === 1 && report.summary.skipped === 2 && report.summary["needs-manual"] === 1
		&& report.summary.total === 8);
	// 报告 sha256 与磁盘实际一致
	const nf = report.files.find((f) => f.rel === "new-file.md");
	check("apply: 报告 sha256 与磁盘实际一致", nf?.sha256 === sha256File(path.join(ws, "new-file.md")));
	// 文本报告人话可读
	const text = formatReport(report);
	check("apply: 文本报告含逐调用/汇总/sha256/不可重放/待人工确认五段",
		/逐调用/.test(text) && /汇总/.test(text) && /sha256/.test(text) && /不可重放清单/.test(text) && /待人工确认/.test(text));
}

// ---------------------------------------------------------------------------
// 4) 边界：edit 目标磁盘不存在 → failed + 停滚（不写新文件）；poisoned 后 write 也停
// ---------------------------------------------------------------------------
{
	const dir = fs.mkdtempSync(path.join(tmpDir, "edge-"));
	const sessionPath = path.join(dir, "s.jsonl");
	fs.writeFileSync(sessionPath, [
		msg(tc("edit", { path: "ghost.md", edits: [{ oldText: "x", newText: "y" }] })), // 目标不存在
		msg(tc("write", { path: "ghost.md", content: "late" })),                        // 停滚后 write 也停（防错位）
	].join("\n") + "\n");
	const report = recoverWorkspace({ sessionPath, root: dir, apply: true });
	check("边界: edit 目标不存在 → failed", report.calls[0].status === "failed");
	check("边界: 停滚后 write 同文件 → skipped", report.calls[1].status === "skipped");
	check("边界: ghost.md 全程未写盘", !fs.existsSync(path.join(dir, "ghost.md")));
}

// ---------------------------------------------------------------------------
// 5) CLI 入口：--apply 真写盘；默认 dry-run 不写盘；退出码
// ---------------------------------------------------------------------------
{
	// apply
	const wsA = path.join(fs.mkdtempSync(path.join(tmpDir, "cli-")), "workspace");
	fs.mkdirSync(wsA);
	const sA = path.join(path.dirname(wsA), "s.jsonl");
	fs.writeFileSync(sA, [
		msg(tc("write", { path: "cli.md", content: "hello\n" })),
		msg(tc("edit", { path: "cli.md", edits: [{ oldText: "hello", newText: "hello world" }] })),
	].join("\n") + "\n");
	const rA = spawnSync(process.execPath, [path.join(repoRoot, "scripts/recover-workspace.mjs"), sA, "--apply", "--cwd", wsA], { encoding: "utf8" });
	check("CLI: --apply 退出码 0", rA.status === 0);
	check("CLI: stdout 含逐调用 applied 与汇总", /applied/.test(rA.stdout) && /汇总/.test(rA.stdout));
	check("CLI: --apply 产物逐字节一致", Buffer.from("hello world\n").equals(fs.readFileSync(path.join(wsA, "cli.md"))));

	// dry-run（默认）
	const wsD = path.join(fs.mkdtempSync(path.join(tmpDir, "cli-")), "workspace");
	fs.mkdirSync(wsD);
	fs.writeFileSync(path.join(wsD, "seed.txt"), "seed");
	const sD = path.join(path.dirname(wsD), "s.jsonl");
	fs.writeFileSync(sD, [msg(tc("write", { path: "dry.md", content: "x" }))].join("\n") + "\n");
	const before = treeHash(wsD);
	const rD = spawnSync(process.execPath, [path.join(repoRoot, "scripts/recover-workspace.mjs"), sD, "--cwd", wsD], { encoding: "utf8" });
	check("CLI: 默认 dry-run 退出码 0", rD.status === 0);
	check("CLI: stdout 标注 DRY-RUN", /DRY-RUN/.test(rD.stdout));
	check("CLI: 默认 dry-run 全树零变化", treeHash(wsD) === before && !fs.existsSync(path.join(wsD, "dry.md")));

	// 退出码：锚 miss → 2
	const wsF = path.join(fs.mkdtempSync(path.join(tmpDir, "cli-")), "workspace");
	fs.mkdirSync(wsF);
	const sF = path.join(path.dirname(wsF), "s.jsonl");
	fs.writeFileSync(sF, [msg(tc("edit", { path: "nope.md", edits: [{ oldText: "a", newText: "b" }] }))].join("\n") + "\n");
	const rF = spawnSync(process.execPath, [path.join(repoRoot, "scripts/recover-workspace.mjs"), sF, "--apply", "--cwd", wsF], { encoding: "utf8" });
	check("CLI: 存在 failed → 退出码 2", rF.status === 2);
}

// ---------------------------------------------------------------------------
// 6) A 件快照：脏区 tar 含脏文件不含 node_modules；干净树 clean 不产 tar
// ---------------------------------------------------------------------------
{
	const repo = fs.mkdtempSync(path.join(tmpDir, "snap-"));
	const outDir = path.join(repo, "snapshots");
	const g = (...a) => execFileSync("git", ["-c", "core.quotePath=false", "-C", repo, ...a], { encoding: "utf8" });
	g("init", "-q");
	g("config", "user.email", "t@t");
	g("config", "user.name", "t");
	fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
	fs.writeFileSync(path.join(repo, "committed.txt"), "keep\n");
	g("add", "-A");
	g("commit", "-q", "-m", "base");

	// 干净树：clean 且不产 tar
	const r0 = takeSnapshot(repo, outDir);
	check("快照: 干净树返回 clean", r0.clean === true);
	check("快照: 干净树不产 tar", r0.tarPath === null && !(fs.existsSync(outDir) && fs.readdirSync(outDir).length > 0));

	// 弄脏：改 tracked + 加 untracked + 塞 node_modules（无 .gitignore 兜底，靠脚本显式排除）
	fs.appendFileSync(path.join(repo, "base.txt"), "dirty\n");
	fs.writeFileSync(path.join(repo, "untracked.txt"), "new\n");
	fs.mkdirSync(path.join(repo, "node_modules"));
	fs.writeFileSync(path.join(repo, "node_modules", "junk.js"), "// junk\n");

	const listed = listDirtyFiles(repo);
	check("快照: 脏区清单含 modified+untracked、排除 node_modules",
		listed.clean === false && listed.files.includes("base.txt") && listed.files.includes("untracked.txt")
		&& !listed.files.some((f) => f.startsWith("node_modules/")));

	const beforeTars = fs.existsSync(outDir) ? fs.readdirSync(outDir).length : 0;
	const r1 = takeSnapshot(repo, outDir);
	check("快照: 脏树产 tar 且落指定目录", r1.clean === false && fs.existsSync(r1.tarPath) && r1.tarPath.startsWith(outDir));
	const entries = execFileSync("tar", ["-tzf", r1.tarPath], { encoding: "utf8" }).trim().split("\n");
	check("快照: tar 内含两个脏文件", entries.includes("base.txt") && entries.includes("untracked.txt"));
	check("快照: tar 内不含 node_modules 与 committed.txt", !entries.some((e) => e.startsWith("node_modules/")) && !entries.includes("committed.txt"));

	// tar 内容逐字节还原校验
	const extractDir = path.join(repo, "extract");
	fs.mkdirSync(extractDir);
	execFileSync("tar", ["-xzf", r1.tarPath, "-C", extractDir]);
	check("快照: 解包 base.txt 与工作区逐字节一致", Buffer.from("base\ndirty\n").equals(fs.readFileSync(path.join(extractDir, "base.txt"))));

	// 再次干净：commit 后 clean 且无新 tar
	g("add", "-A");
	g("commit", "-q", "-m", "all");
	const r2 = takeSnapshot(repo, outDir);
	check("快照: 收尾 commit 后返回 clean 且不产新 tar", r2.clean === true && fs.readdirSync(outDir).length === beforeTars + 1);
}

console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
