#!/usr/bin/env node
// 发车前快照 A 件：对 git 脏区（tracked modified + untracked）打 tar.gz 快照落 /tmp。
// 诞生背景：10/8 审批单复验现场 `git checkout -- .` 误清未 commit 的pianist施工——
// 若发车前有这份快照，误清后直接解 tar 兜底，不必手工重放会话。
//
// 规则：
//   - 脏区文件 = git ls-files --modified（仍存在于磁盘的；已删除的不进 tar，git checkout 自可恢复）
//               + git ls-files --others --exclude-standard（untracked，尊重 .gitignore）
//   - 显式排除 node_modules/、.git/（即使没被 .gitignore 兜住也排）
//   - 干净树：短路输出 clean，不产 tar
//
// 用法：
//   node scripts/prespawn-snapshot.mjs              # 快照 process.cwd()，tar 落 /tmp
//   可选: --cwd <dir> 指定仓库根  --out <dir> 指定 tar 输出目录（默认 /tmp）

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function git(root, ...args) {
	return execFileSync("git", ["-c", "core.quotePath=false", "-C", root, ...args], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
}

// ---------------------------------------------------------------------------
// 脏区文件清单（相对 root 路径，已排序、已排除 node_modules/.git/不存在文件）
// ---------------------------------------------------------------------------

export function listDirtyFiles(root) {
	root = path.resolve(root);
	const status = git(root, "status", "--porcelain");
	if (status.trim() === "") return { clean: true, files: [] };

	const files = new Set();
	for (const line of git(root, "ls-files", "--modified").split("\n")) {
		const f = line.trimEnd();
		if (f) files.add(f);
	}
	for (const line of git(root, "ls-files", "--others", "--exclude-standard").split("\n")) {
		const f = line.trimEnd();
		if (f) files.add(f);
	}

	const filtered = [...files].filter((f) => {
		if (f === ".git" || f.startsWith(".git/")) return false;
		if (f === "node_modules" || f.startsWith("node_modules/")) return false;
		const abs = path.join(root, f);
		if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false; // 已删除/子模块目录不进 tar
		return true;
	}).sort();

	return { clean: false, files: filtered };
}

// ---------------------------------------------------------------------------
// 快照：脏区 → tar.gz
// ---------------------------------------------------------------------------

export function takeSnapshot(root = process.cwd(), outDir = "/tmp") {
	root = path.resolve(root);
	const { clean, files } = listDirtyFiles(root);
	if (clean) return { clean: true, tarPath: null, files: [] };
	if (files.length === 0) {
		// 脏区条目全是已删除/被排除文件，无可快照内容——按干净处理，不产 tar
		return { clean: true, tarPath: null, files: [], note: "脏区仅为已删除/被排除条目，无可快照文件" };
	}

	fs.mkdirSync(outDir, { recursive: true });
	const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14); // YYYYMMDDHHMMSS（UTC）
	const rand = Math.random().toString(36).slice(2, 8);
	const tarPath = path.join(outDir, `prespawn-snap-${ts}-${rand}.tar.gz`);

	// NUL 分隔清单传给 tar --null -T（文件名含空格/换行也不碎）
	const listPath = path.join(outDir, `.${path.basename(tarPath)}.list`);
	fs.writeFileSync(listPath, Buffer.concat(files.flatMap((f) => [Buffer.from(f, "utf8"), Buffer.from("\0")])));
	try {
		execFileSync("tar", ["-czf", tarPath, "--null", "-C", root, "-T", listPath]);
	} finally {
		fs.rmSync(listPath, { force: true });
	}
	return { clean: false, tarPath, files, bytes: fs.statSync(tarPath).size };
}

// ---------------------------------------------------------------------------
// CLI 入口
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
	const argv = process.argv.slice(2);
	const flagValue = (name) => {
		const i = argv.indexOf(name);
		return i !== -1 ? argv[i + 1] : undefined;
	};
	const root = flagValue("--cwd") ?? process.cwd();
	const outDir = flagValue("--out") ?? "/tmp";
	try {
		const r = takeSnapshot(root, outDir);
		if (r.clean) {
			console.log(`clean（${root} 工作树干净，未产快照${r.note ? "——" + r.note : ""}）`);
		} else {
			console.log(`snapshot ${r.tarPath}（${r.files.length} 个脏文件，${r.bytes}B）`);
			for (const f of r.files) console.log(`  ${f}`);
		}
	} catch (err) {
		console.error(`快照失败: ${err.message}`);
		process.exit(1);
	}
}
