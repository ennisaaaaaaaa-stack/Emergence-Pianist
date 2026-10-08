#!/usr/bin/env node
// credentials/store.mjs —— 凭证存储（钥匙柜 v2）：每把钥匙一个普通文件，值只进文件不出口。
// v1（T11）是匿名保险箱：list 只出名字，答不了「谁的、为什么存、管哪些仓、上次验证什么时候」。
// v2（T16）三件套：
//   ① sidecar 来历档案：meta/<名>.meta.json（明文，不含值）——owner/purpose/scope+scope_snapshot_at/
//      last_verified{source:declared|tested, at}。写钥匙必须带 owner+purpose（强制闸：匿名不入柜）。
//   ② 墓碑：destroy 时 meta/<名>.tombstone.json（name/fingerprint/reason/ts）——遗忘的是值，记住的是身份；
//      同名 write 复活时清掉墓碑。sidecar 与墓碑住 meta/ 子目录（700）而非柜目录同层——
//      <名>.meta.json 能过 NAME_RE，放同层会污染 list()。
//   ③ status：一条命令回答hui三问（谁的/为什么存/管哪些仓截至何时/上次验证来源+时间）。
//      无 sidecar 的 v1 老钥匙显示「来历缺失」并 stderr 出声提醒补登；has/read/use/list 全功能照旧。
// scope 快照纪律：fine-grained PAT 的授权名单是铸造时刻的快照——scope 必须带「截至何时」
// （scope_snapshot_at）：后来建的门开不了，看时间戳就知道，不用拿真请求去试错。
// 验证来源二值：declared（口头/文档声明）vs tested（真请求实测），不许混称；没有默认 verified。
// 用户仍是凭证的主人：cat/编辑/删文件等效接口；agent 侧只见名字表（list）与指纹。
// CLI（值永远走 stdin，不走命令行）：
//   printf '%s' "$VAL" | node credentials/store.mjs write <名> --owner <谁> --purpose <为什么> \
//     [--scope "a,b,c"] [--scope-at <ISO>] [--verified declared|tested] [--verified-at <ISO>]
//   node credentials/store.mjs meta <名> [--owner …] [--purpose …] [--scope …] [--scope-at …] [--verified …] [--verified-at …]
//   node credentials/store.mjs status [--json] | list | has <名> | destroy <名> [--reason <死因>] | fingerprint <名>
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

// sidecar/墓碑统一住 meta/ 子目录（700），不放柜目录同层——<名>.meta.json 能过 NAME_RE，同层会污染 list()
function metaDir() {
	return path.join(credDir(), "meta");
}
function metaFileOf(name) {
	return path.join(metaDir(), `${name}.meta.json`);
}
function tombFileOf(name) {
	return path.join(metaDir(), `${name}.tombstone.json`);
}

function ensureDir() {
	const dir = credDir();
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700); // 目录权限收不紧就出声抛错，不静默
}

function ensureMetaDir() {
	fs.mkdirSync(metaDir(), { recursive: true, mode: 0o700 });
	fs.chmodSync(metaDir(), 0o700);
}

/** 名字表（永不含值；meta/ 是目录被 isFile 滤掉）。目录不存在视为空表。 */
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

/** 读 sidecar：无→null（v1 老钥匙）；坏 JSON→stderr 出声按无来历处理（不许炸 status）。 */
export function readMeta(name) {
	assertName(name);
	let raw;
	try {
		raw = fs.readFileSync(metaFileOf(name), "utf8");
	} catch (e) {
		if (e.code === "ENOENT") return null;
		throw e;
	}
	try {
		return JSON.parse(raw);
	} catch (e) {
		console.warn(`[store] ${name} 的 sidecar 坏了（${e.message}）——按来历缺失处理`);
		return null;
	}
}

/** 把补丁 merge 进 sidecar（传啥改啥，不传的字段保留）。scope 更新时快照时刻缺省=现在；
 *  scope_at 显式给是考古补录。verified 二值 declared|tested，verified_at 缺省=登记时刻。 */
function mergeSidecar(existing, patch = {}) {
	const side = { ...existing };
	if (patch.owner !== undefined) side.owner = patch.owner;
	if (patch.purpose !== undefined) side.purpose = patch.purpose;
	if (patch.scope !== undefined) {
		if (Array.isArray(patch.scope) && patch.scope.length > 0) {
			side.scope = patch.scope;
			side.scope_snapshot_at = patch.scope_at ?? new Date().toISOString();
		} else {
			delete side.scope; // 空数组=清空 scope（快照时刻随之作废）
			delete side.scope_snapshot_at;
		}
	}
	if (patch.verified !== undefined) side.last_verified = { source: patch.verified, at: patch.verified_at ?? new Date().toISOString() };
	side.updated_at = new Date().toISOString();
	return side;
}

function writeMetaFile(name, side) {
	ensureMetaDir();
	const p = metaFileOf(name);
	fs.writeFileSync(p, JSON.stringify(side, null, "\t") + "\n", { mode: 0o600 });
	fs.chmodSync(p, 0o600);
}

/** 写入：值走参数（API）或 stdin（CLI），永不走命令行。文件权限 600。
 *  v2 强制来历：meta 必须带 owner+purpose（匿名不入柜——考古问「谁的、为什么存」要在写时刻答）。
 *  自动落库方自带 owner 即过闸（如 mask.mjs 的 owner:"auto-mask"）。 */
export function write(name, value, meta) {
	assertName(name);
	if (typeof value !== "string" || value.length === 0) throw new Error(`拒绝写入空值：${name}`);
	if (!meta || typeof meta !== "object" || !meta.owner || !meta.purpose) {
		throw new Error(`write 必须带来历：write(${JSON.stringify(name)}, value, { owner, purpose })——v2 起匿名不入柜（老钥匙补登用 meta 子命令）`);
	}
	ensureDir();
	const p = fileOf(name);
	fs.writeFileSync(p, value, { mode: 0o600 });
	fs.chmodSync(p, 0o600);
	fs.rmSync(tombFileOf(name), { force: true }); // 同名复活：清旧墓碑（值回来了，档案重开）
	writeMetaFile(name, mergeSidecar(readMeta(name), meta)); // merge 已有 sidecar：换值不丢 scope 快照等考古信息
	journal("write", { name });
}

/** 补登/更新来历（merge 语义：传啥改啥，不传的字段保留）——给 v1 老钥匙补 sidecar、给新钥匙改档用。 */
export function applyMeta(name, patch = {}) {
	assertName(name);
	if (!fs.existsSync(fileOf(name))) throw new Error(`钥匙不存在：${name}`);
	writeMetaFile(name, mergeSidecar(readMeta(name), patch));
	journal("meta", { name });
}

/** 销毁：值照删；墓碑记 name/fingerprint/reason/ts（指纹销毁前取，删后无从取）；journal destroy 照旧。 */
export function destroy(name, { reason = "未注明" } = {}) {
	assertName(name);
	const p = fileOf(name);
	if (!fs.existsSync(p)) throw new Error(`钥匙不存在：${name}`);
	const fp = fingerprintValue(fs.readFileSync(p, "utf8"));
	fs.rmSync(p);
	fs.rmSync(metaFileOf(name), { force: true }); // sidecar 随钥匙下葬——墓碑是死钥匙的唯一档案
	ensureMetaDir();
	const t = tombFileOf(name);
	fs.writeFileSync(t, JSON.stringify({ name, fingerprint: fp, reason, ts: new Date().toISOString() }, null, "\t") + "\n", { mode: 0o600 });
	fs.chmodSync(t, 0o600);
	journal("destroy", { name });
}

/** 墓碑表（meta/ 里 *.tombstone.json，按销毁时间排序；目录不存在视为空，单座坏墓碑不拖垮整表）。 */
export function listTombstones() {
	try {
		return fs
			.readdirSync(metaDir())
			.filter((n) => n.endsWith(".tombstone.json"))
			.map((n) => {
				try {
					return JSON.parse(fs.readFileSync(path.join(metaDir(), n), "utf8"));
				} catch {
					return null;
				}
			})
			.filter(Boolean)
			.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
	} catch (e) {
		if (e.code === "ENOENT") return [];
		throw e;
	}
}

/** status 数据面（人读与 --json 同源）：活钥匙（含 sidecar 摘要）+墓碑表。老钥匙 meta:false。 */
export function statusData() {
	const keys = list().map((name) => {
		const m = readMeta(name);
		if (!m) return { name, meta: false };
		return {
			name,
			meta: true,
			owner: m.owner ?? null,
			purpose: m.purpose ?? null,
			scope: Array.isArray(m.scope) ? m.scope : null,
			scope_snapshot_at: m.scope_snapshot_at ?? null,
			last_verified: m.last_verified ?? null, // {source:"declared"|"tested", at}
		};
	});
	return { dir: credDir(), keys, tombstones: listTombstones() };
}

/** status 人读：一条命令回答hui三问。来历缺失的老钥匙 stderr 出声提醒补登（stdout 照列，不炸）。 */
function printStatus() {
	const d = statusData();
	const w = Math.max(12, ...d.keys.map((k) => k.name.length), ...d.tombstones.map((t) => String(t.name ?? "").length));
	const out = [`钥匙柜 status：${d.keys.length} 把活钥匙 / ${d.tombstones.length} 座墓碑（${d.dir}）`];
	for (const k of d.keys) {
		if (!k.meta) {
			out.push(`${k.name.padEnd(w)}  [来历缺失]（v1 遗留，其余功能照旧）`);
			out.push(`${"".padEnd(w)}  验证: 从未验证`);
			console.error(`[store] 钥匙 ${k.name} 无来历登记（v1 遗留）——补登：node credentials/store.mjs meta ${k.name} --owner <谁> --purpose <为什么存>`);
			continue;
		}
		out.push(`${k.name.padEnd(w)}  ${k.owner ?? "?"} / ${k.purpose ?? "?"}`);
		out.push(`${"".padEnd(w)}  scope: ${k.scope ? `${k.scope.join(", ")}（截至 ${k.scope_snapshot_at ?? "?"}）` : "—（未登记）"}`);
		out.push(`${"".padEnd(w)}  验证: ${k.last_verified ? `${k.last_verified.source} @ ${k.last_verified.at}` : "从未验证"}`);
	}
	out.push("");
	out.push(`墓碑（${d.tombstones.length}）:`);
	for (const t of d.tombstones) {
		out.push(`${String(t.name ?? "?").padEnd(w)}  指纹 ${t.fingerprint ?? "?"}  死因：${t.reason ?? "未注明"}  销毁于 ${t.ts ?? "?"}`);
	}
	console.log(out.join("\n"));
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
	const usage =
		"用法: node credentials/store.mjs <write <名> --owner <谁> --purpose <为什么> [--scope a,b,c] [--scope-at ISO] [--verified declared|tested] [--verified-at ISO]（值从 stdin 读）| meta <名> [--owner …] [--purpose …] [--scope …] [--scope-at …] [--verified …] [--verified-at …]（merge 补登）| status [--json] | list | has <名> | destroy <名> [--reason <死因>] | fingerprint <名>>";

	/** flag 解析：--key value（booleanFlags 白名单里的为布尔）。未知/缺值 flag 出声 exit 2。 */
	function parseFlags(args, booleanFlags = []) {
		const flags = {};
		for (let i = 0; i < args.length; i++) {
			const a = args[i];
			if (!a.startsWith("--")) {
				console.error(`[store] 不认的参数：${a}`);
				process.exit(2);
			}
			const key = a.slice(2);
			if (booleanFlags.includes(key)) {
				flags[key] = true;
			} else if (i + 1 < args.length) {
				flags[key] = args[++i];
			} else {
				console.error(`[store] --${key} 缺值`);
				process.exit(2);
			}
		}
		return flags;
	}

	/** 来历 flag 轻校验：verified 二值不许混称；时间戳须可解析。坏形状 exit 2 出声。 */
	function validatePatchFlags(flags) {
		if (flags.verified !== undefined && flags.verified !== "declared" && flags.verified !== "tested") {
			console.error(`[store] --verified 只收 declared（口头/文档声明）| tested（真请求实测），不许混称——收到：${flags.verified}`);
			process.exit(2);
		}
		for (const k of ["scope-at", "verified-at"]) {
			const v = flags[k];
			if (v !== undefined && Number.isNaN(Date.parse(v))) {
				console.error(`[store] --${k} 需为可解析的 ISO 时间（考古补录用），收到：${v}`);
				process.exit(2);
			}
		}
	}

	/** CLI flags → write/applyMeta 的 patch 形状（--scope 逗号分隔转数组）。 */
	function flagsToPatch(flags) {
		const patch = {};
		if (flags.owner !== undefined) patch.owner = flags.owner;
		if (flags.purpose !== undefined) patch.purpose = flags.purpose;
		if (flags.scope !== undefined) patch.scope = flags.scope.split(",").map((s) => s.trim()).filter(Boolean);
		if (flags["scope-at"] !== undefined) patch.scope_at = flags["scope-at"];
		if (flags.verified !== undefined) patch.verified = flags.verified;
		if (flags["verified-at"] !== undefined) patch.verified_at = flags["verified-at"];
		return patch;
	}

	const [cmd, name, ...rest] = process.argv.slice(2);
	try {
		if (cmd === "write") {
			if (!name) {
				console.error(usage);
				process.exit(2);
			}
			const flags = parseFlags(rest);
			validatePatchFlags(flags);
			if (!flags.owner || !flags.purpose) {
				console.error("[store] write 必须带 --owner 与 --purpose（v2 强制来历：匿名不入柜——考古要能答「谁的、为什么存」）");
				console.error(usage);
				process.exit(2);
			}
			let value = fs.readFileSync(0, "utf8"); // 值从 stdin 进，永不上命令行
			value = value.replace(/\r?\n$/, "");
			if (!value) {
				console.error("[store] stdin 为空：拒绝写入空值");
				process.exit(2);
			}
			write(name, value, flagsToPatch(flags));
			console.log(`已存 ${name}（指纹 ${fingerprint(name)}）`);
		} else if (cmd === "meta") {
			if (!name) {
				console.error(usage);
				process.exit(2);
			}
			const flags = parseFlags(rest);
			validatePatchFlags(flags);
			applyMeta(name, flagsToPatch(flags));
			console.log(`已登记 ${name} 的来历（merge：传啥改啥）`);
		} else if (cmd === "status") {
			const flags = parseFlags([name, ...rest].filter((a) => a !== undefined), ["json"]); // status 无名位参数，--json 可能占在 name 位
			journal("status", {});
			if (flags.json) console.log(JSON.stringify(statusData(), null, 2));
			else printStatus();
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
			if (!name) {
				console.error(usage);
				process.exit(2);
			}
			const flags = parseFlags(rest);
			destroy(name, { reason: flags.reason ?? "未注明" });
			console.log(`已销毁 ${name}（墓碑落 meta/${name}.tombstone.json）`);
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
