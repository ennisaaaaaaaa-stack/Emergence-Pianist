// 拆卸测试·正常会话场：PIANIST_TELEMETRY=off 下pianist跑真任务
// 验证：①功能完好（bridge 查家、bash、read 都干活）②拔掉遥测后会话无感（无报错无变慢）
import { spawn } from "node:child_process";

const TASK = `做三件事：1) 用 pianist_bridge 工具查家里的工作台（action=spoor_list，payload 空对象），报第一个项目名；2) 用 bash 跑 date +%s 报时间戳；3) 用 read 读 package.json 报 version 字段值。三行报完。`;

const env = {
	...process.env,
	PIANIST_AGENT_ID: "pianist-dev-1",
	PIANIST_SHELL_URL: "http://127.0.0.1:8770",
	PIANIST_TELEMETRY: "off", // ← 拔插头：纯零开销开关（extension 不注册任何监听器）
	ZAI_CODING_CN_API_KEY: process.env.ZAI_CODING_CN_API_KEY || "",
	NO_COLOR: "1",
};

const t0 = Date.now();
const child = spawn("./node_modules/.bin/pi", ["-p", "--model", "zai-coding-cn/glm-5.2", TASK], {
	cwd: ".",
	env,
	stdio: ["ignore", "pipe", "pipe"],
});
let out = "";
child.stdout.on("data", (d) => { out += d.toString(); });
child.stderr.on("data", (d) => { out += d.toString(); });
const killer = setTimeout(() => child.kill("SIGKILL"), 180_000);
child.on("close", (code) => {
	clearTimeout(killer);
	console.log(out.trim().split("\n").slice(-6).join("\n"));
	console.log(`(exit ${code}, 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
});
