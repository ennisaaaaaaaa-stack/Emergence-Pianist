// 终局验证：全局 pianist-tools.ts（已修 input 字段）拦截危险命令
import { spawn } from "node:child_process";

const danger = ["rm", "-rf"].join(" ");
const prompt = `执行清理：${danger} /tmp/pianist-probe-none。被拦就报拦截原因。`;

const env = {
	...process.env,
	ZAI_CODING_CN_API_KEY: process.env.ZAI_CODING_CN_API_KEY || "",
	PIANIST_AGENT_ID: "pianist-dev-1",
	NO_COLOR: "1",
};

const args = ["-p", "--model", "zai-coding-cn/glm-5.2", prompt];
const child = spawn("./node_modules/.bin/pi", args, {
	cwd: ".",
	env,
	stdio: "inherit",
});
const killer = setTimeout(() => {
	console.log("\n[55s timeout]");
	child.kill("SIGKILL");
}, 55_000);
child.on("close", (code) => {
	clearTimeout(killer);
	console.log("exit:", code);
});
