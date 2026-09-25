// 热路径正戏：造一个「真值得记」的 candidate 场景——pianist连续 4 天修同类编译错误
// （同指纹 read→bash(同构编译命令)→edit，错误后再来一轮——真实工作里长 skill 的形状）
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// repo 根按本文件位置解析——spawn 相对路径按子进程 cwd 解析，cwd 指向
// /tmp/retropad-fixture 时 ./node_modules/... 会 ENOENT（公版干净环境复现过）
const PI_BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", ".bin", "pi");

// 任务：修一个可复现的失败测试（真文件真失败真修——不是演的）
// /tmp/retropad-fixture/math.test.js 有个 bug：加法写成减法。每轮让pianist：
// 跑测试（失败）→ 读文件 → 修 → 再跑（过）。四轮，每轮重新引入 bug（脚本把文件重置）。
import fs from "node:fs";
fs.mkdirSync("/tmp/retropad-fixture", { recursive: true });
const BUGGED = `function add(a, b) { return a - b; }  // bug: should be +
module.exports = { add };
`;
const FIXED = `function add(a, b) { return a + b; }
module.exports = { add };
`;
const TEST = `const { add } = require("./math.js");
if (add(1, 1) !== 2) { console.error("FAIL: add(1,1)=" + add(1, 1)); process.exit(1); }
console.log("PASS");
`;
fs.writeFileSync("/tmp/retropad-fixture/math.js", BUGGED);
fs.writeFileSync("/tmp/retropad-fixture/math.test.js", TEST);

const TASK = `到 /tmp/retropad-fixture 目录修一个失败的测试：1) 用 bash 跑 cd /tmp/retropad-fixture && node math.test.js 看失败；2) 用 read 读 /tmp/retropad-fixture/math.js；3) 用 edit 把 math.js 修到测试过；4) 用 bash 重跑 node math.test.js 确认 PASS。只报最终一行结果。`;

const env = {
	...process.env,
	PIANIST_AGENT_ID: "pianist-dev-2",
	PIANIST_SHELL_URL: "http://127.0.0.1:8770",
	ZAI_CODING_CN_API_KEY: process.env.ZAI_CODING_CN_API_KEY || "",
	// T5：夹具轮关遥测——fixture 的 TDD 红绿循环是刻意制造的扫描信号，
	// 落进遥测会在 14 天窗里冒充热点（9/25 真数据首扫实证：错误热点×12 全是它）
	PORTALK_TELEMETRY: "off",
	NO_COLOR: "1",
};

for (let i = 1; i <= 4; i++) {
	fs.writeFileSync("/tmp/retropad-fixture/math.js", BUGGED); // 每轮重置 bug
	console.log(`===== 第 ${i} 轮 =====`);
	await new Promise((resolve) => {
		const child = spawn(PI_BIN, ["-p", "--model", "zai-coding-cn/glm-5.2", TASK], {
			cwd: "/tmp/retropad-fixture",
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "";
		child.stdout.on("data", (d) => { out += d.toString(); });
		child.stderr.on("data", (d) => { out += d.toString(); });
		const killer = setTimeout(() => child.kill("SIGKILL"), 180_000);
		child.on("close", (code) => {
			clearTimeout(killer);
			console.log(out.trim().split("\n").slice(-2).join("\n"));
			console.log(`(exit ${code})`);
			resolve();
		});
	});
}
// 最后留 fixed 版
fs.writeFileSync("/tmp/retropad-fixture/math.js", FIXED);
console.log("===== 4 轮完 =====");
