#!/usr/bin/env node
// credentials/store.mjs —— 凭证存储（钥匙柜）：每把钥匙一个普通文件，值只进文件不出口。
// 用户是凭证的主人：cat/编辑/删直接操作文件等效；agent 侧只见名字表（list）与指纹。
// CLI（值永远走 stdin，不走命令行）：
//   printf '%s' "$VAL" | node credentials/store.mjs write <名字>
//   node credentials/store.mjs list | has <名字> | destroy <名字> | fingerprint <名字>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { journal } from "./journal.mjs";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** 存储目录（测试用 PORTALK_CRED_DIR 覆盖到 tmp 夹具）。 */
export function credDir() {
	return process.env.PORTALK_CRED_DIR ?? path.join(os.homedir(), ".portalk", "credentials");
}

function assertName(name) {
	if (typeof name !== "string" || !NAME_RE.test(name)) {
		throw new Error(`钥匙名不合法：${JSON.stringify(String(name))}（仅字母数字与 ._-，≤64 字符）`);
	}
}

function fileOf(name) {
	return path.join(credDir(), name);
}

function ensureDir() {
	const dir = credDir();
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700); // 目录权限收不紧就出声抛错，不静默
}

/** 名字表（永不含值）。目录不存在视为空表。 */
export function list() {
	try {
		return fs
			.readdirSync(credDir(), { withFileTypes: true })
			.filter((d) => d.isFile())
			.map((d) => d.name)
			.filter((n) => NAME_RE.test(n))
			.sort();
	} catch (e) {
		if (e.code === "ENOENT") return [];
		throw e;
	}
}

export function has(name) {
	assertName(name);
	return fs.existsSync(fileOf(name));
}

/** 读值——只供运行时内部件（broker/inject/mask/scan）用，任何调用方不得打印。 */
export function readValue(name) {
	assertName(name);
	return fs.readFileSync(fileOf(name), "utf8");
}

/** 写入：值走参数（API）或 stdin（CLI），永不走命令行。文件权限 600。 */
export function write(name, value) {
	assertName(name);
	if (typeof value !== "string" || value.length === 0) throw new Error(`拒绝写入空值：${name}`);
	ensureDir();
	const p = fileOf(name);
	fs.writeFileSync(p, value, { mode: 0o600 });
	fs.chmodSync(p, 0o600);
	journal("write", { name });
}

export function destroy(name) {
	assertName(name);
	const p = fileOf(name);
	if (!fs.existsSync(p)) throw new Error(`钥匙不存在：${name}`);
	fs.rmSync(p);
	journal("destroy", { name });
}

/** sha256 前 8 hex——兜底扫描用，不是值本身。 */
export function fingerprintValue(value) {
	return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 8);
}

export function fingerprint(name) {
	return fingerprintValue(readValue(name));
}

// ---- CLI 形态 ----
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
	const [cmd, name] = process.argv.slice(2);
	const usage =
		"用法: node credentials/store.mjs <write <名字>（值从 stdin 读）| list | has <名字> | destroy <名字> | fingerprint <名字>>";
	try {
		if (cmd === "write") {
			if (!name) {
				console.error(usage);
				process.exit(2);
			}
			let value = fs.readFileSync(0, "utf8"); // 值从 stdin 进，永不上命令行
			value = value.replace(/\r?\n$/, "");
			if (!value) {
				console.error("[store] stdin 为空：拒绝写入空值");
				process.exit(2);
			}
			write(name, value);
			console.log(`已存 ${name}（指纹 ${fingerprint(name)}）`);
		} else if (cmd === "list") {
			journal("list", {});
			const names = list();
			console.log(names.length ? names.join("\n") : "(空)");
		} else if (cmd === "has") {
			if (!name) {
				console.error(usage);
				process.exit(2);
			}
			console.log(has(name) ? "true" : "false");
		} else if (cmd === "destroy") {
			destroy(name);
			console.log(`已销毁 ${name}`);
		} else if (cmd === "fingerprint") {
			if (!name) {
				console.error(usage);
				process.exit(2);
			}
			console.log(fingerprint(name));
		} else {
			console.error(usage);
			process.exit(2);
		}
	} catch (e) {
		console.error(`[store] ${e.message}`);
		process.exit(1);
	}
}
