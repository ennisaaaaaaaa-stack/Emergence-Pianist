#!/usr/bin/env node
// credentials/env-source.mjs —— env 过渡态下线的供给口（T15 活一，2026-10-05）。
// 钥匙柜（T11）落地前的过渡态：key 明文住 .bashrc / conductor.env 两处。
// 下线后的正路：值只住钥匙柜，消费进程启动时从柜读一次装进 env——本模块就是那个「启动时」。
// 契约（与 t9-microvm-scope §五同源）：
//   1) 柜里有 → 读柜，落 use-vault 事件（记账只有名字没有值，与 broker/inject 同纪律）
//   2) 柜里没有、进程 env 里有 → 过渡回落：出声 + env-fallback 事件——回落不静默，
//      回落日志就是「明文 env 还没死透」的存量清单，全部消费点切柜后应绝迹
//   3) 两处都没有 → 返回 undefined，由调用方各自的「缺 key 大声死」兜底（已有测试钉着，不重复造）
// 值不出本模块边界：返回给调用方装 env 用，任何调用方不得打印。
import { has, readValue } from "./store.mjs";
import { journal } from "./journal.mjs";

/**
 * 供给一个 env 变量：钥匙柜优先，env 过渡回落。
 * @param {string} varName env 变量名（报错/记账引用）
 * @param {string} keyName 钥匙柜里的钥匙名
 * @returns {string|undefined} 值（双无时 undefined）
 */
export function envOrVault(varName, keyName) {
	if (has(keyName)) {
		journal("use-vault", { name: keyName, var: varName });
		return readValue(keyName);
	}
	const fromEnv = process.env[varName];
	if (fromEnv !== undefined) {
		console.warn(
			`[credentials] 过渡回落：${varName} 走进程 env 明文（钥匙柜里没有 ${keyName}）——env 过渡态待下线，见 docs/t15-env-offline.md`,
		);
		journal("env-fallback", { name: keyName, var: varName });
	}
	return fromEnv;
}
