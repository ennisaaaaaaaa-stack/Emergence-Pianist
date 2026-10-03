// credentials/scan.mjs —— 指纹兜底：对文本做全量存储值精确匹配，命中替换成 [credential:<名字>]。
// 作为任何东西进日志/遥测前的最后一道闸（mask 是入口的尽力而为，scan 是落盘前的硬闸）。
import { list, readValue } from "./store.mjs";

export function scanText(text) {
	let out = String(text);
	if (!out) return out;
	for (const name of list()) {
		let value;
		try {
			value = readValue(name);
		} catch {
			continue; // 单把钥匙读不出不拖垮整道闸
		}
		if (!value || value.length < 4) continue; // 过短值全文替换噪音大于收益
		if (!out.includes(value)) continue;
		out = out.split(value).join(`[credential:${name}]`);
	}
	return out;
}
