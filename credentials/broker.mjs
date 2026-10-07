#!/usr/bin/env node
// credentials/broker.mjs —— 全代发（纯度第一档，key 不进 agent 进程文本）：
// 读存储 → 替换 header/body 模板里的 {VALUE} → spawn curl（天然吃 env 代理）→ 只回响应 body。
// 值永不上进程命令行：header 走 curl 的 -H @file、body 走 --data-binary @file（600 权限临时文件，用完即删）。
// 打印前过 scanText 保险带：输出里若意外含值，替换成 [credential:<名字>] 再出门。
//
// 结构（T15 活二拆核）：核=brokerCore（可导入，被 credentials CLI 与 sandbox/gate-proxy 的
// vault.internal 内部端点共用——沙箱内 agent 隔墙喊钥匙，key 永不进沙箱文本域）；壳=下方 CLI。
//
// 反探洞（命门）：broker 在墙外有全网访问权，沙箱内 agent 若能把目标指到内网，等于借 broker
// 绕过沙箱 netns 隔离探内网。故默认拒 RFC1918/环回/链路本地/裸 IP 目标（含 DNS 解析结果复核）。
// 逃生门是 options 参数 allowPrivate（默认 false，仅测试显式传），不设 env 逃生门。
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readValue } from "./store.mjs";
import { scanText } from "./scan.mjs";
import { authorize } from "./tiers.mjs";
import { journal } from "./journal.mjs";
// 复用 gate-proxy 已有的 CIDR 判定（函数声明提升，与 gate-proxy↔broker 互引共存，同 store↔journal↔scan 先例）
import { ipInCidrs, parseCidr } from "../sandbox/gate-proxy.mjs";

// 反探洞默认网段：与沙箱策略 hardDeny 同谱（RFC1918/环回/链路本地/CGNAT/ULA），另收 0.0.0.0/8 与组播
const PRIVATE_TARGET_CIDRS = [
	"0.0.0.0/8",
	"10.0.0.0/8",
	"100.64.0.0/10",
	"127.0.0.0/8",
	"169.254.0.0/16",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"224.0.0.0/4",
	"::1/128",
	"fe80::/10",
	"fc00::/7",
].map(parseCidr);

/**
 * broker 核：读柜 → 授权 → 反探洞 → 模板替换 → spawn curl → scanText 输出。
 * 调用方：credentials CLI（本文件下方）与 sandbox/gate-proxy 的 vault.internal/use 端点。
 * @param {object} o
 * @param {string} o.name 钥匙名（只有名字，值在墙外读柜）
 * @param {string} o.url 目标（http/https）
 * @param {string} [o.method] 默认 POST
 * @param {string|string[]} [o.headers] 模板 header（{VALUE} 占位）
 * @param {string} [o.body] 模板 body（{VALUE} 占位）
 * @param {boolean} [o.allowPrivate] 测试逃生门：默认 false=拒内网/环回/裸 IP 目标
 * @param {string} [o.journalAction] 记账 action（CLI=use-broker，沙箱=use-sandbox-broker）
 * @param {string} [o.agent] 记账工牌（沙箱路径传 policy.identity.agent）
 * @param {string} [o.intentPrefix] 授权 intent 前缀（审计语义用）
 * @param {string} [o.task] use 记账语境（T16：用在哪，约定 <调用方>:<语境>；缺省不落账）
 * @returns {Promise<{ok:true, body:string, tier:string}|{ok:false, status:number, exitCode:number, error:string}>}
 *   body/error 均已过 scanText；status 是给 gate 端点的 HTTP 状态，exitCode 是给 CLI 的退出码。
 *   永不 reject（内部异常一律转 ok:false 人话错误）——gate 进程不容许被钥匙柜异常炸掉。
 */
export async function brokerCore(opts) {
	try {
		return await brokerCoreInner(opts);
	} catch (e) {
		return { ok: false, status: 500, exitCode: 1, error: scanText(`[broker] 内部错误：${e?.message ?? e}`) };
	}
}

async function brokerCoreInner({
	name,
	url,
	method = "POST",
	headers = [],
	body,
	allowPrivate = false,
	journalAction = "use-broker",
	agent = null,
	intentPrefix = "broker",
	task,
} = {}) {
	const fail = (status, exitCode, error) => ({ ok: false, status, exitCode, error: scanText(error) });

	// ① 形状（大声拒，不静默）
	if (typeof name !== "string" || !name) return fail(400, 2, "缺钥匙名 name");
	if (typeof url !== "string" || !url) return fail(400, 2, "缺目标 url");
	if (typeof method !== "string" || !method) return fail(400, 2, "method 不合法");
	const hdrs = typeof headers === "string" ? [headers] : headers;
	if (!Array.isArray(hdrs) || !hdrs.every((h) => typeof h === "string"))
		return fail(400, 2, "headers 需为字符串或字符串数组");
	if (body !== undefined && typeof body !== "string") return fail(400, 2, "body 需为字符串（{VALUE} 占位模板）");
	let u;
	try {
		u = new URL(url);
	} catch {
		return fail(400, 2, `url 无法解析：${url}`);
	}
	if (u.protocol !== "http:" && u.protocol !== "https:")
		return fail(400, 2, `url 协议只收 http/https（收到 ${u.protocol}）`);

	// ② 授权（无配置/per-use 未批=出声拒绝）
	const verdict = await authorize(name, { intent: `${intentPrefix} ${method} ${url}` });
	if (!verdict.allowed) return fail(403, 3, `[broker] 拒绝使用钥匙 ${name}：${verdict.reason}`);

	// ③ 反探洞（命门）：默认拒内网/环回/裸 IP——broker 有全网访问权，不能变成沙箱的探洞探头
	if (!allowPrivate) {
		const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
		if (net.isIP(host))
			return fail(403, 3, `[broker] 拒绝裸 IP 目标 ${host}：broker 默认拒（防借 broker 绕过沙箱 netns 探内网；测试场景显式传 allowPrivate）`);
		let addrs;
		try {
			addrs = await dns.lookup(host, { all: true });
		} catch (e) {
			return fail(502, 4, `[broker] 目标 ${host} DNS 解析失败：${e.code ?? e.message}`);
		}
		const bad = addrs.find((a) => ipInCidrs(a.address, PRIVATE_TARGET_CIDRS));
		if (bad) return fail(403, 3, `[broker] 拒绝内网目标 ${host}（解析到 ${bad.address}）：broker 默认拒（防探洞）`);
	}

	// ④ 读柜（柜无此钥匙=人话错误，不裸抛栈）
	let value;
	try {
		value = readValue(name);
	} catch (e) {
		return fail(403, 4, `[broker] 钥匙柜里没有这把钥匙：${name}（${e.code === "ENOENT" ? "文件不存在" : e.message}）`);
	}

	// ⑤ 模板替换 + tmpFile 纪律（值永不上命令行：-H @file / --data-binary @file，600 权限用完即删）
	const tmpFiles = [];
	function tmpFile(tag, content) {
		const p = path.join(os.tmpdir(), `portalk-cred-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
		fs.writeFileSync(p, content, { mode: 0o600 });
		fs.chmodSync(p, 0o600);
		tmpFiles.push(p);
		return p;
	}
	const args = ["-sS", "--max-time", "60", "-X", method];
	args.push("-H", `@${tmpFile("header", hdrs.map((h) => h.replaceAll("{VALUE}", value)).join("\n"))}`);
	if (body !== undefined) args.push("--data-binary", `@${tmpFile("body", body.replaceAll("{VALUE}", value))}`);

	// ⑥ 记账（只有名字没有值；沙箱路径 agent=沙箱工牌，由调用方传入；task=use 语境透传，缺省由 journal 卫兵剔掉）
	journal(journalAction, { name, tier: verdict.tier, method, host: u.host, ...(agent ? { agent } : {}), context: task });

	// ⑦ 发送：curl 天然吃 env 代理；环回目标不该被外层代理劫走 → 确保 no_proxy 覆盖环回
	let out = "",
		err = "",
		exitCode = 0;
	try {
		await new Promise((resolve) => {
			const loopback = "127.0.0.1,localhost";
			const env = {
				...process.env,
				no_proxy: process.env.no_proxy ? `${process.env.no_proxy},${loopback}` : loopback,
				NO_PROXY: process.env.NO_PROXY ? `${process.env.NO_PROXY},${loopback}` : loopback,
			};
			const child = spawn("curl", [...args, url], { env, stdio: ["ignore", "pipe", "pipe"] });
			child.stdout.on("data", (d) => (out += d));
			child.stderr.on("data", (d) => (err += d));
			child.on("error", (e) => {
				err = `[broker] curl 启动失败：${e.message}`;
				exitCode = 127;
				resolve();
			});
			child.on("close", (c) => {
				exitCode = c ?? 127;
				resolve();
			});
		});
	} finally {
		for (const p of tmpFiles) fs.rmSync(p, { force: true }); // 临时文件用完即删
	}

	if (exitCode === 0) return { ok: true, body: scanText(out), tier: verdict.tier }; // 只回响应 body，且先过全量值扫描
	return fail(502, exitCode, err.trim() ? `[broker] ${err.trim()}` : `[broker] curl 退出码 ${exitCode}（目标 ${u.host}）`);
}

// ---- CLI 壳（与拆核前行为零变化；新增 --allow-private 仅测试夹具用） ----
const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
	const argv = process.argv.slice(2);
	let name = null,
		url = null,
		method = "POST",
		body,
		allowPrivate = false,
		task;
	const headers = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--name") name = argv[++i];
		else if (argv[i] === "--url") url = argv[++i];
		else if (argv[i] === "--method") method = argv[++i];
		else if (argv[i] === "--header") headers.push(argv[++i]);
		else if (argv[i] === "--body") body = argv[++i];
		else if (argv[i] === "--allow-private") allowPrivate = true;
		else if (argv[i] === "--task") task = argv[++i];
		else {
			console.error(`broker: 未知参数 ${argv[i]}`);
			process.exit(2);
		}
	}
	if (!name || !url || headers.length === 0) {
		console.error(
			"用法: node credentials/broker.mjs --name <钥匙名> --url <URL> [--method POST] [--header 'Authorization: Bearer {VALUE}'] [--body <str>] [--task <语境>] [--allow-private]",
		);
		process.exit(2);
	}

	const r = await brokerCore({ name, url, method, headers, body, allowPrivate, task });
	if (!r.ok) {
		console.error(r.error);
		process.exit(r.exitCode);
	}
	process.stdout.write(r.body);
}
