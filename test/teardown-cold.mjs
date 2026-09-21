// 拆卸测试·冷启动场：壳杀重启后的全新 session（无任何跨进程状态）
// 验证：①经图注入仍在（context 钩子→壳 grimoire_map→首轮注入）②bridge 仍通
// 验证方式：问pianist一个「只有经图注入才可能知道」的问题——Grimoire经图的结构
import { spawn } from "node:child_process";

const TASK = `不要调用任何工具，凭你开场拿到的注入内容回答：你开场的 [技能经图（Grimoire）] 注入里，待审区（draft）报的数量是多少？只报数字和一句话。`;

const env = {
	...process.env,
	PIANIST_AGENT_ID: "pianist-dev-1",
	PIANIST_SHELL_URL: "http://127.0.0.1:8770",
	PIANIST_TELEMETRY: "off",
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
	console.log(out.trim().split("\n").slice(-4).join("\n"));
	console.log(`(exit ${code}, 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
});
