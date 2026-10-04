// sandbox/gate-proxy.mjs —— 白名单门禁代理（沙箱外进程，unix socket，是沙箱出网的唯一门）
// 形态：netns 内只有 lo，应用经 HTTP 代理（127.0.0.1:8788，netns-relay 绑）出网；
// relay 把字节原样搬到本代理（unix socket 跨 netns），白名单/硬拒/记账的判断全在这边（可信侧）。
// 门禁不是囚室：预置白名单直接放行；硬拒的只有真泄密通道（内网管理面/环回/裸 IP）；
// 白名单外的新端点先通后报——放行本次 + 首次落 journal。
//
// 钥匙柜内部端点（T15 活二）：目标 hostname 为保留域 vault.internal 的明文代理请求不出网、
// 不过 decide，直接转墙外 brokerCore（credentials/broker.mjs）——沙箱内 agent 给 {VALUE} 模板，
// 墙外读柜填值、直连真实目标、只回响应 body。key 永不进沙箱文本域；反探洞由 brokerCore 默认
// 拒内网/环回/裸 IP 目标兜底（防借 broker 绕过 netns 探内网）。
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { appendJournalLine } from "./journal.mjs";
import { brokerCore } from "../credentials/broker.mjs";

const MAX_HEAD = 64 * 1024; // 代理请求头上限
const VAULT_HOST = "vault.internal"; // 保留域（不撞真实域名），沙箱内 agent 隔墙喊钥匙的固定名
const VAULT_MAX_BODY = 1024 * 1024; // /use 请求体上限（模板不该比这更大）
const STATUS_TEXT = {
	200: "OK",
	400: "Bad Request",
	403: "Forbidden",
	404: "Not Found",
	405: "Method Not Allowed",
	413: "Payload Too Large",
	500: "Internal Server Error",
	502: "Bad Gateway",
};

// ---- IP/CIDR 最小实现（零依赖） ----
function parseIp4(ip) {
	if (!net.isIPv4(ip)) return null;
	let v = 0n;
	for (const o of ip.split(".")) v = (v << 8n) | BigInt(Number(o));
	return v;
}
function parseIp6(str) {
	if (!net.isIPv6(str)) return null;
	const dc = str.indexOf("::");
	const side = (s) => (s === "" ? [] : s.split(":"));
	const parseGroups = (arr) =>
		arr
			.map((g) => {
				if (g.includes(".")) {
					const v = parseIp4(g);
					if (v === null) throw new Error("bad v4 tail");
					return [(v >> 16n) & 0xffffn, v & 0xffffn];
				}
				return [BigInt(parseInt(g, 16) || 0)];
			})
			.flat();
	try {
		const h = parseGroups(side(dc >= 0 ? str.slice(0, dc) : str));
		const t = dc >= 0 ? parseGroups(side(str.slice(dc + 2))) : [];
		const fill = 8 - h.length - t.length;
		if (dc < 0 && h.length !== 8) return null;
		if (dc >= 0 && (fill < 1 || t.length === 0) && str !== "::") {
			if (fill < 0) return null;
		}
		const all = [...h, ...Array(Math.max(fill, 0)).fill(0n), ...t];
		if (all.length !== 8) return null;
		return all.reduce((a, g) => (a << 16n) | (g & 0xffffn), 0n);
	} catch {
		return null;
	}
}
/** 解析 "a.b.c.d/n" 或 "x::/n" → {family, net, bits}（credentials/broker.mjs 反探洞共用） */
export function parseCidr(cidr) {
	const [addr, bitsStr] = cidr.split("/");
	const bits = Number(bitsStr);
	if (net.isIPv4(addr)) {
		const v = parseIp4(addr);
		if (v === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
		const mask = bits === 0 ? 0n : (0xffffffffn << BigInt(32 - bits)) & 0xffffffffn;
		return { family: 4, net: v & mask, bits };
	}
	const v = parseIp6(addr);
	if (v === null || !Number.isInteger(bits) || bits < 0 || bits > 128) return null;
	const mask = bits === 0 ? 0n : (0xffffffffffffffffffffffffffffffffn << BigInt(128 - bits)) &
			0xffffffffffffffffffffffffffffffffn;
	return { family: 6, net: v & mask, bits };
}
/** IP 是否落在任一 CIDR 内（credentials/broker.mjs 反探洞共用） */
export function ipInCidrs(ip, cidrs) {
	const v4 = parseIp4(ip);
	if (v4 !== null) {
		for (const c of cidrs) {
			if (c.family !== 4) continue;
			const mask = c.bits === 0 ? 0n : (0xffffffffn << BigInt(32 - c.bits)) & 0xffffffffn;
			if ((v4 & mask) === c.net) return true;
		}
		return false;
	}
	const v6 = parseIp6(ip);
	if (v6 === null) return false;
	for (const c of cidrs) {
		if (c.family !== 6) continue;
		const mask = c.bits === 0 ? 0n : (0xffffffffffffffffffffffffffffffffn << BigInt(128 - c.bits)) &
				0xffffffffffffffffffffffffffffffffn;
		if ((v6 & mask) === c.net) return true;
	}
	return false;
}
function parseHostPort(target, defaultPort) {
	let host = target;
	let port = defaultPort;
	const m = target.match(/^\[(.+)\]:(\d+)$/); // [::1]:443
	if (m) return { host: m[1], port: Number(m[2]) };
	const i = target.lastIndexOf(":");
	if (i > 0 && !target.includes("]", i)) {
		const p = Number(target.slice(i + 1));
		if (Number.isInteger(p)) {
			host = target.slice(0, i);
			port = p;
		}
	}
	return { host, port };
}

/**
 * 起门禁代理。
 * @returns {{socketPath:string, close:()=>void, journaledHosts:string[]}} ready 是 Promise。
 */
export function startGateProxy({ policy, scratchDir, agent = "pianist", journalPath }) {
	const socketPath = path.join(scratchDir, "gate.sock");
	const cidrs = policy.network.hardDeny.cidrs.map(parseCidr).filter(Boolean);
	const seen = new Set(); // 本次进程已记账的新端点（每端点每回合只落一次账）
	const journaledHosts = [];
	// 测试逃生门（仅测试置位；不设=拒内网，默认安全）：开时 brokerCore 允许 private 目标（mock 起在环回上用）
	const allowPrivateTargets = process.env.PORTALK_SANDBOX_BROKER_ALLOW_PRIVATE === "1";

	function journalNewEndpoint(host) {
		if (seen.has(host)) return;
		seen.add(host);
		journaledHosts.push(host);
		appendJournalLine(journalPath, {
			agent,
			host,
			scope: "sandbox-new-endpoint",
			note: `先通后报：${policy.name} 白名单外端点本次放行（复盘时审，硬拒清单未命中）`,
		});
	}

	/** 判门禁：白名单放行；硬拒（裸 IP/禁段/解析到禁段）403；白名单外新端点放行+记账 */
	async function decide(hostRaw) {
		const host = String(hostRaw).toLowerCase().replace(/\.$/, "");
		const hd = policy.network.hardDeny;
		if (net.isIP(host)) {
			// 裸 IP 直连一律硬拒（不是恶意，是没必要）；即便 bareIp=false，IP 也无域可白
			if (ipInCidrs(host, cidrs))
				return { allow: false, code: 403, reason: `hard-deny: 禁段 ${host}` };
			return { allow: false, code: 403, reason: `hard-deny: 裸 IP 直连 ${host}` };
		}
		const whitelisted = (policy.network.allowDomains ?? []).some(
			(d) => host === d || host.endsWith("." + d),
		);
		// DNS 复核（白名单内外都查）：解析到内网/环回的一律硬拒，防域名指向管理面
		let addrs;
		try {
			addrs = await dns.lookup(host, { all: true });
		} catch (e) {
			return { allow: false, code: 502, reason: `dns 解析失败: ${e.code ?? e.message}` };
		}
		const bad = addrs.find((a) => ipInCidrs(a.address, cidrs));
		if (bad) return { allow: false, code: 403, reason: `hard-deny: ${host} 解析到 ${bad.address}` };
		if (!whitelisted) journalNewEndpoint(host);
		return { allow: true, whitelisted };
	}

	function pipe(a, b) {
		a.pipe(b);
		b.pipe(a);
		b.on("error", () => a.destroy());
		a.on("error", () => b.destroy());
	}

	const server = net.createServer((sock) => {
		let buf = Buffer.alloc(0);
		let dispatched = false; // 头已消费、方向已定（decide/connect 在途时继续攒字节但不重解析）
		let pipeEngaged = false; // 透传管道已接管，此后数据归管道
		let answered = false; // 已回应答（连接将关），后续字节忽略
		let vaultReq = null; // vault.internal 请求攒 body 中：{ method, u, head, headEnd }

		const reply = (code, contentType, body) => {
			if (answered) return;
			answered = true;
			try {
				sock.end(
					`HTTP/1.1 ${code} ${STATUS_TEXT[code] ?? "Error"}\r\nContent-Type: ${contentType}\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
				);
			} catch {}
		};
		const replyText = (code, text) =>
			reply(code, "text/plain; charset=utf-8", `sandbox-gate: ${text}\n`);
		const replyVault = (code, text) =>
			reply(code, "text/plain; charset=utf-8", `vault.internal: ${text}\n`);

		/** vault.internal 请求：按 Content-Length 攒足请求体再处理（普通代理路径无需攒 body，直接透传） */
		const vaultStep = () => {
			const { method, u, head, headEnd } = vaultReq;
			const lines = head.split("\r\n").slice(1);
			let contentLength = null;
			let clCount = 0;
			let chunked = false;
			for (const h of lines) {
				if (/^content-length:/i.test(h)) {
					clCount++;
					const m = h.match(/^content-length:\s*(\d+)\s*$/i);
					if (m) contentLength = Number(m[1]);
				}
				if (/^transfer-encoding:\s*chunked/i.test(h)) chunked = true;
			}
			if (clCount > 1) {
				vaultReq = null;
				return replyVault(400, "拒绝：多个 Content-Length 头");
			}
			if (chunked) {
				vaultReq = null;
				return replyVault(400, "不收 Transfer-Encoding: chunked（请带 Content-Length）");
			}
			const need = contentLength ?? 0;
			if (need > VAULT_MAX_BODY) {
				vaultReq = null;
				return replyVault(413, `请求体超限（上限 ${VAULT_MAX_BODY} 字节）`);
			}
			if (buf.length < headEnd + need) return; // 攒足再处理
			const bodyBuf = buf.subarray(headEnd, headEnd + need);
			vaultReq = null;
			handleVaultUse(method, u, bodyBuf).catch((e) =>
				replyVault(500, `内部错误：${e?.message ?? e}`),
			);
		};

		/** vault.internal/use：形状校验 → 墙外 brokerCore（读柜→授权→反探洞→填值→直连）→ 只回响应 body */
		async function handleVaultUse(method, u, bodyBuf) {
			if (u.pathname !== "/use")
				return replyVault(404, `只开 /use 端点（收到 ${u.pathname}）`);
			if (method !== "POST") return replyVault(405, `/use 只收 POST（收到 ${method}）`);
			let req;
			try {
				req = JSON.parse(bodyBuf.toString("utf8"));
			} catch {
				return replyVault(400, "请求体不是合法 JSON（形状：{ name, url, method?, header?, body? }）");
			}
			const bad = (msg) => replyVault(400, `${msg}（形状：{ name, url, method?, header?, body? }）`);
			if (typeof req?.name !== "string" || !req.name) return bad("缺 name：钥匙名（字符串）");
			if (typeof req?.url !== "string" || !req.url) return bad("缺 url：目标（字符串）");
			if (req.method !== undefined && typeof req.method !== "string") return bad("method 需为字符串");
			let headers = [];
			if (req.header !== undefined) {
				if (typeof req.header === "string") headers = [req.header];
				else if (Array.isArray(req.header) && req.header.every((h) => typeof h === "string"))
					headers = req.header;
				else return bad("header 需为字符串或字符串数组（模板，{VALUE} 占位）");
			}
			if (req.body !== undefined && typeof req.body !== "string")
				return bad("body 需为字符串（模板，{VALUE} 占位）");

			const r = await brokerCore({
				name: req.name,
				url: req.url,
				method: req.method ?? "POST",
				headers,
				body: req.body,
				allowPrivate: allowPrivateTargets, // 默认 false：不设 env=拒内网（防借 broker 探洞）
				journalAction: "use-sandbox-broker",
				agent: policy.identity?.agent ?? agent, // 记账工牌=沙箱工牌，不是 pianist 默认值
				intentPrefix: "sandbox-broker",
			});
			if (!r.ok) return replyVault(r.status, r.error); // 错误文本已在 brokerCore 过 scanText
			reply(200, "application/octet-stream", r.body); // 响应 body 已过 scanText：值零回流沙箱
		}

		sock.on("data", (chunk) => {
			if (pipeEngaged) return; // 管道已接管
			buf = Buffer.concat([buf, chunk]);
			if (answered) return;
			if (vaultReq) return vaultStep();
			if (dispatched) return; // 在途：攒着，等接通上游后随剩余字节一并写出去
			const idx = buf.indexOf("\r\n\r\n");
			if (idx < 0) {
				if (buf.length > MAX_HEAD) replyText(400, "请求头超限");
				return;
			}
			const head = buf.subarray(0, idx).toString("latin1");
			const line = head.split("\r\n")[0];

			const conn = line.match(/^CONNECT\s+(\S+)\s+HTTP\/[\d.]+$/i);
			if (conn) {
				const { host, port } = parseHostPort(conn[1], 443);
				dispatched = true;
				decide(host).then((d) => {
					if (!d.allow) return replyText(d.code, d.reason);
					const up = net.connect(port, host);
					up.on("connect", () => {
						sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
						if (buf.length > idx + 4) up.write(buf.subarray(idx + 4));
						pipeEngaged = true;
						pipe(sock, up);
					});
					up.on("error", (e) => replyText(502, `upstream: ${e.message}`));
				});
				return;
			}
			const req = line.match(/^([A-Z]+)\s+(\S+)\s+HTTP\/[\d.]+$/);
			if (req) {
				const [, method, target] = req;
				let u;
				try {
					u = new URL(target);
				} catch {
					return replyText(400, "无法解析请求目标");
				}
				if (u.protocol !== "http:")
					return replyText(502, "明文代理只收 http 绝对地址；https 请走 CONNECT 隧道");
				// 钥匙柜内部端点：vault.internal 不出网、不过 decide，转墙外 brokerCore
				if (u.hostname.toLowerCase().replace(/\.$/, "") === VAULT_HOST) {
					dispatched = true;
					vaultReq = { method, u, head, headEnd: idx + 4 };
					return vaultStep();
				}
				dispatched = true;
				decide(u.hostname).then((d) => {
					if (!d.allow) return replyText(d.code, d.reason);
					const up = net.connect(Number(u.port) || 80, u.hostname);
					up.on("connect", () => {
						const restHead = head.split("\r\n").slice(1).join("\r\n");
						up.write(
							`${method} ${u.pathname}${u.search} HTTP/1.1\r\n${restHead}\r\n\r\n`,
						);
						if (buf.length > idx + 4) up.write(buf.subarray(idx + 4));
						pipeEngaged = true;
						pipe(sock, up);
					});
					up.on("error", (e) => replyText(502, `upstream: ${e.message}`));
				});
				return;
			}
			replyText(400, "非代理协议（本端口只做 HTTP 门禁代理）");
		});
		sock.on("error", () => {});
	});

	const ready = new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			// unix socket 属主是 root（执行器），沙箱内 nobody 要能 connect → 0666
			try {
				fs.chmodSync(socketPath, 0o666);
			} catch {}
			resolve();
		});
	});

	return {
		socketPath,
		ready,
		journaledHosts,
		close() {
			try {
				server.close();
			} catch {}
			try {
				fs.unlinkSync(socketPath);
			} catch {}
			for (const s of server.clients ?? []) s.destroy();
		},
	};
}
