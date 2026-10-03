// sandbox/run-sandboxed.mjs —— 轻档沙箱执行器 CLI 入口
// 语法：node sandbox/run-sandboxed.mjs --policy sandbox/policies/default.policy.json [--agent pianist] [--timeout-ms 120000] -- <command...>
import { runSandboxed } from "./executor.mjs";

const argv = process.argv.slice(2);
let policyPath = null;
let agent;
let timeoutMs;
let cmdStart = -1;
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--policy" && i + 1 < argv.length) policyPath = argv[++i];
	else if (argv[i] === "--agent" && i + 1 < argv.length) agent = argv[++i];
	else if (argv[i] === "--timeout-ms" && i + 1 < argv.length) timeoutMs = Number(argv[++i]);
	else if (argv[i] === "--") {
		cmdStart = i + 1;
		break;
	} else {
		console.error(`run-sandboxed: 未知参数 ${argv[i]}`);
		process.exit(2);
	}
}
const command = argv.slice(cmdStart);
if (!policyPath || command.length === 0) {
	console.error("用法: node sandbox/run-sandboxed.mjs --policy <file> [--agent pianist] [--timeout-ms N] -- <command...>");
	process.exit(2);
}

let run;
try {
	run = await runSandboxed({ command, policyPath, agent, timeoutMs });
} catch (e) {
	console.error(`[run-sandboxed] ${e.message}`);
	process.exit(125);
}
process.exit(run.code ?? (run.signal ? 137 : 0));
