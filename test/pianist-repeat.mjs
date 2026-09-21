// 热路径测试数据生成：pianist真跑 3 轮同构任务（read→bash→append）产生重复遥测
import { spawn } from "node:child_process";

const TASK = "帮我做一轮检查：1) 用 read 工具读 package.json；2) 用 bash 跑 node --version；3) 把 node 版本号一行追加进 /tmp/check-result.txt（用 bash echo）。做完只报 done。";

const env = {
	...process.env,
	PIANIST_AGENT_ID: "pianist-dev-1",
	PIANIST_SHELL_URL: "http://127.0.0.1:8770",
	ZAI_CODING_CN_API_KEY: process.env.ZAI_CODING_CN_API_KEY || "",
	NO_COLOR: "1",
};

for (let i = 1; i <= 3; i++) {
	console.log(`===== 第 ${i} 轮 =====`);
	await new Promise((resolve) => {
		const child = spawn("./node_modules/.bin/pi", ["-p", "--model", "zai-coding-cn/glm-5.2", TASK], {
			cwd: ".",
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (d) => { out += d.toString(); });
		child.stderr.on("data", (d) => { out += d.toString(); });
		const killer = setTimeout(() => child.kill("SIGKILL"), 120_000);
		child.on("close", (code) => {
			clearTimeout(killer);
			console.log(out.trim().split("\n").slice(-3).join("\n"));
			console.log(`(exit ${code})`);
			resolve();
		});
	});
}
console.log("===== 3 轮完 =====");
