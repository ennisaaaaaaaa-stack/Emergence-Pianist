#!/usr/bin/env node
// credentials/inject.mjs —— env 注入（纯度第二档：命令纯，/proc 理论可翻——沙箱层可堵，接缝留后续铲）。
// spawn 时从存储读值装进 env，透传 stdio 与退出码；wrapper 自身不打任何含值的日志。
// --task <语境>：use-inject 记账透传（T16：用在哪，如 test:inject-task；缺省不落账）。
import { spawn } from "node:child_process";
import { readValue } from "./store.mjs";
import { authorize } from "./tiers.mjs";
import { journal } from "./journal.mjs";

const argv = process.argv.slice(2);
const envPairs = [];
let task = null;
let cmdStart = -1;
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--env" && i + 1 < argv.length) envPairs.push(argv[++i]);
	else if (argv[i] === "--task" && i + 1 < argv.length) task = argv[++i];
	else if (argv[i] === "--") {
		cmdStart = i + 1;
		break;
	} else {
		console.error(`inject: 未知参数 ${argv[i]}`);
		process.exit(2);
	}
}
const command = argv.slice(cmdStart);
if (envPairs.length === 0 || command.length === 0) {
	console.error("用法: node credentials/inject.mjs --env VAR=<钥匙名> [--env VAR2=<名2>] [--task <语境>] -- <命令...>");
	process.exit(2);
}

const injected = {};
for (const pair of envPairs) {
	const eq = pair.indexOf("=");
	if (eq <= 0) {
		console.error(`[inject] --env 形状应为 VAR=<钥匙名>，收到：${pair.slice(0, 64)}`);
		process.exit(2);
	}
	const varName = pair.slice(0, eq);
	const keyName = pair.slice(eq + 1);
	const verdict = await authorize(keyName, { intent: `inject ${varName}` });
	if (!verdict.allowed) {
		console.error(`[inject] 拒绝使用钥匙 ${keyName}：${verdict.reason}`);
		process.exit(3);
	}
	injected[varName] = readValue(keyName);
	journal("use-inject", { name: keyName, tier: verdict.tier, context: task }); // --task 语境透传（缺省由 journal 卫兵剔掉）
}

const child = spawn(command[0], command.slice(1), {
	env: { ...process.env, ...injected },
	stdio: "inherit", // 透传 stdio
});
child.on("error", (e) => {
	console.error(`[inject] 启动失败：${e.message}`);
	process.exit(127);
});
child.on("close", (code, signal) => process.exit(signal ? 137 : (code ?? 0))); // 透传退出码
