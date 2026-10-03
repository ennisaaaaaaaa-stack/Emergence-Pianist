// credentials/mask.mjs —— 入口码掉：用户消息里疑似凭证在进上下文前替换成 [凭证#n]（码值不码义）。
// 检测=形状+语境双半边（docs/t9-microvm-scope.md §五），保守策略：宁可漏不可误伤。
//   形状半边：高置信前缀（sk-/ghp_/AKIA/PEM）、≥32 hex、≥40 base64 样串、连接串、KEY=紧凑值 env 行、Authorization 头。
//   语境半边：宣告词（密码/secret/key/令牌/验证码/token）同一行紧挨紧凑非语言串。
// 码掉的值经 write() 落存储（名字从语境推，推不出用 unnamed-<hash8>）；OTP（验证码语境）码掉即弃不落存储。
import { has, readValue, write as storeWrite, fingerprintValue } from "./store.mjs";

// ---- 语境半边词表 ----
const ANNOUNCE_RE = /(密码|口令|密钥|令牌|验证码|\bsecret\b|\bpassword\b|\bpassphrase\b|\btoken\b|\bapi[\s_-]?key\b|\bkey\b)/gi;
const OTP_RE = /(验证码|\botp\b|one[\s-]?time|一次性)/i;
// 纯数字值须密码/验证码类宣告词在场（「端口是 8770」无宣告词天然放行；「token 3600 秒」类也不误伤）
const DIGIT_OK_RE = /(密码|口令|验证码|\bpassword\b|\bpassphrase\b|\bpin\b|pin\s*码)/i;
// 紧凑 ASCII 串（排除空白、括号/引号/分号等代码壳与全部 CJK）
const TOKEN_RE = /[A-Za-z0-9!#$%&*+\-_.:=?@^~|/]{4,256}/g;
const ANNOUNCE_WORDISH = /^(api[\s_-]?key|key|token|secret|password|passphrase)$/i;

/** 语境半边的紧凑串资格判定：宁可漏不可误伤。 */
function isCandidateToken(tok, before, line) {
	if (tok.includes("://")) return false; // 无密码的 URL 不码（带密码的连接串由形状半边管）
	if (/^[A-Za-z]+$/.test(tok)) return false; // 纯单词=语言
	if (/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(tok)) return false; // 邮箱
	if (/^#[0-9a-fA-F]{3,8}$/.test(tok)) return false; // 颜色值
	if (/^\d+(ms|s|h|m|d|px|pt|em|rem|kb|mb|gb|tb|hz|khz|mhz)$/i.test(tok)) return false; // 带单位量
	if (/^v?\d+(\.\d+)+(-[A-Za-z0-9.]+)?$/.test(tok)) return false; // 版本号
	if (!/\d/.test(tok) && /^[A-Za-z0-9_./-]+$/.test(tok)) return false; // 无数字的代码标识符/路径（config.get、api_key）
	if (ANNOUNCE_WORDISH.test(tok)) return false; // 宣告词自身不当值
	if (/^[0-9]+$/.test(tok) && !DIGIT_OK_RE.test(line)) return false; // 纯数字须密码/验证码语境（判句子不判数字）
	if (/(端口|port|编号|号码|行号|版本|version)\s*[#:=是]?\s*$/i.test(before)) return false; // 端口/编号前置语放行
	return true;
}

/** 从宣告词左邻文本推钥匙名（ASCII 标识符，如 GITHUB token → github）；推不出返回 null。 */
function inferName(line, announceStart) {
	const ids = [...line.slice(0, announceStart).matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g)]
		.map((m) => m[0])
		.filter((w) => !ANNOUNCE_WORDISH.test(w) && !/^(the|my|a|an|your|is|的)$/i.test(w));
	return ids.length ? ids[ids.length - 1].toLowerCase() : null;
}

/** env 行 KEY=紧凑值 的值侧资格：≥16、字母+数字、非 URL/路径/locale/版本/邮箱。 */
function envValueLooksSecret(v) {
	if (v.length < 16) return false;
	if (!/\d/.test(v) || !/[A-Za-z]/.test(v)) return false;
	if (v.includes("://")) return false;
	if (/^(\/|~\/|\.\/)/.test(v)) return false;
	if (/^[a-z]{2}_[A-Z]{2}(\.[A-Za-z0-9-]+)?$/.test(v)) return false; // LANG=en_US.UTF-8
	if (/^v?\d+(\.\d+)+/.test(v)) return false;
	if (/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(v)) return false;
	return true;
}

// 去重收录：同值只记一次（先到先得定位置）；后到的可补名字（形状先收无名、语境后补名）。
function add(byValue, value, index, name = null, otp = false) {
	if (!value || value.length < 4) return;
	const cur = byValue.get(value);
	if (!cur) byValue.set(value, { value, index, name, otp });
	else if (!cur.name && name) cur.name = name;
}

// ---- 形状半边 ----
function collectShape(text, byValue) {
	for (const m of text.matchAll(/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]{0,4000}?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----/g)) {
		add(byValue, m[0], m.index); // PEM：整块是钥匙
	}
	for (const re of [/\bsk-[A-Za-z0-9_-]{12,}/g, /\bghp_[A-Za-z0-9]{16,}/g, /\bAKIA[0-9A-Z]{16}\b/g]) {
		for (const m of text.matchAll(re)) add(byValue, m[0], m.index);
	}
	for (const m of text.matchAll(/\b[0-9a-fA-F]{32,}\b/g)) add(byValue, m[0], m.index); // ≥32 hex
	for (const m of text.matchAll(/[A-Za-z0-9+/]{40,}={0,2}/g)) {
		// ≥40 base64 样串：须数字+大小写混杂，降低散文/代码误伤
		if (/\d/.test(m[0]) && /[a-z]/.test(m[0]) && /[A-Z]/.test(m[0])) add(byValue, m[0], m.index);
	}
	for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"']+:[^\s:@/"']{4,}@/g)) {
		// 连接串 scheme://user:pass@ —— 只码密码段，user/host 留给上下文（码值不码义）
		const part = m[0].slice(m[0].indexOf("://") + 3, -1); // user:pass
		const pass = part.slice(part.lastIndexOf(":") + 1);
		add(byValue, pass, m.index + m[0].length - 1 - pass.length);
	}
	for (const m of text.matchAll(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*([^\s]+)[ \t]*$/gm)) {
		const key = m[1];
		let raw = m[2];
		if (/^["'].*["']$/.test(raw) && raw.length >= 2) raw = raw.slice(1, -1);
		if (envValueLooksSecret(raw)) add(byValue, raw, m.index + m[0].indexOf(raw), key); // 名字=KEY 本身
	}
	for (const m of text.matchAll(/authorization[ \t]*:[ \t]*(?:bearer|token|basic|digest)[ \t]+([A-Za-z0-9._+/=-]{16,})/gi)) {
		add(byValue, m[1], m.index + m[0].length - m[1].length); // 只码 scheme 后的凭据段
	}
}

// ---- 语境半边 ----
function collectContext(text, byValue) {
	let lineStart = 0;
	for (const line of text.split("\n")) {
		const announces = [...line.matchAll(ANNOUNCE_RE)];
		if (announces.length > 0) {
			const tokens = [...line.matchAll(TOKEN_RE)];
			const otp = OTP_RE.test(line);
			for (const a of announces) {
				for (const t of tokens) {
					const ts = t.index,
						te = t.index + t[0].length;
					if (ts < a.index + a[0].length && te > a.index) continue; // 与宣告词重叠
					const near = (ts >= a.index + a[0].length && ts - (a.index + a[0].length) <= 24) || (te <= a.index && a.index - te <= 24);
					if (!near) continue;
					if (!isCandidateToken(t[0], line.slice(0, ts).slice(-12), line)) continue;
					const name = otp ? null : inferName(line, a.index);
					add(byValue, t[0], lineStart + ts, name, otp && !byValue.has(t[0]));
				}
			}
		}
		lineStart += line.length + 1;
	}
}

/**
 * 入口码掉：maskText(text) → { masked, found:[{ placeholder, name|null, otp }] }
 * 同文本多把钥匙按首次出现顺序编号 [凭证#1] [凭证#2]；非 OTP 值落存储，OTP 码掉即弃。
 */
export function maskText(text) {
	const src = String(text);
	const byValue = new Map();
	collectShape(src, byValue);
	collectContext(src, byValue);
	// 按首次出现位置排序，并剔除被更早命中包住的重叠子串（如 PEM 内部的 hex 行）
	const ordered = [...byValue.values()]
		.sort((a, b) => a.index - b.index)
		.filter((f, i, arr) => !arr.slice(0, i).some((g) => g !== f && g.value.includes(f.value)));
	let masked = src;
	const found = [];
	for (let i = 0; i < ordered.length; i++) {
		const f = ordered[i];
		const ph = `[凭证#${i + 1}]`;
		masked = masked.split(f.value).join(ph);
		if (f.otp) {
			found.push({ placeholder: ph, name: null, otp: true }); // OTP：码掉即弃，不落存储
			continue;
		}
		const name = f.name || `unnamed-${fingerprintValue(f.value)}`;
		if (!has(name) || readValue(name) !== f.value) storeWrite(name, f.value); // 值经 write() 落钥匙柜
		found.push({ placeholder: ph, name, otp: false });
	}
	return { masked, found };
}
