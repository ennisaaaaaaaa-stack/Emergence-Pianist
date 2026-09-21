// 施工②端到端：pianist → pianist_bridge → 壳 → spoor/Grimoire
// 前置：壳(8770)/Grimoire(8730)/spoor三实例(8793-8795)在跑
// 用法：node test/bridge-e2e-test.mjs [自定义prompt]
import { spawn } from "node:child_process";

const prompt = process.argv[2] ?? `用 pianist_bridge 工具查一下家里的账：action 用 spoor_list，payload 空对象。把返回的工作台列表里第一个项目名报给我，一行即可。`;

const env = {
	...process.env,
	ZAI_CODING_CN_API_KEY: process.env.ZAI_CODING_CN_API_KEY || "",
	PIANIST_AGENT_ID: "pianist-dev-1",
	PIANIST_SHELL_URL: "http://127.0.0.1:8770",
	NO_COLOR: "1",
};

const args = ["-p", "--model", "zai-coding-cn/glm-5.2", prompt];
const child = spawn("./node_modules/.bin/pi", args, {
	cwd: ".",
	env,
	stdio: "inherit",
});
const killer = setTimeout(() => {
	console.log("\n[90s timeout]");
	child.kill("SIGKILL");
}, 90_000);
child.on("close", (code) => {
	clearTimeout(killer);
	console.log("exit:", code);
});
