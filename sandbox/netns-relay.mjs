// sandbox/netns-relay.mjs —— netns 内门禁中继（在沙箱内跑，先于真实命令拉起）
// 职责：在 netns 的 lo 上绑 127.0.0.1:8788，把进来的字节原样搬到沙箱外 gate-proxy（unix socket
// 跨 netns），然后 spawn 真实命令并透传 stdio、回传退出码。判门禁不在这层——这层只是网线。
// 注意：stdio 必须全程透传给真实命令，本文件不许往 stdout 打印任何东西（诊断走 stderr 且默认关）。
import { spawn } from "node:child_process";
import net from "node:net";

const args = process.argv.slice(2);
let gatePath = null;
let port = 8788;
let i = 0;
for (; i < args.length; i++) {
	if (args[i] === "--gate" && i + 1 < args.length) gatePath = args[++i];
	else if (args[i] === "--port" && i + 1 < args.length) port = Number(args[++i]);
	else if (args[i] === "--") {
		i++;
		break;
	} else {
		console.error(`[netns-relay] 未知参数 ${args[i]}`);
		process.exit(2);
	}
}
const cmd = args.slice(i);
if (!gatePath || cmd.length === 0) {
	console.error("用法: node netns-relay.mjs --gate <sock> [--port 8788] -- cmd...");
	process.exit(2);
}

const server = net.createServer((conn) => {
	const up = net.connect(gatePath);
	conn.pipe(up);
	up.pipe(conn);
	const drop = () => {
		conn.destroy();
		up.destroy();
	};
	up.on("error", drop);
	conn.on("error", drop);
	up.on("close", () => conn.end());
	conn.on("close", () => up.end());
});
server.on("error", (e) => {
	console.error(`[netns-relay] 门禁中继监听失败（127.0.0.1:${port}）: ${e.message}`);
	process.exit(125);
});

server.listen(port, "127.0.0.1", () => {
	const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit" });
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
		process.on(sig, () => {
			try {
				child.kill(sig);
			} catch {}
		});
	child.on("error", (e) => {
		console.error(`[netns-relay] 命令拉起失败 ${cmd[0]}: ${e.message}`);
		server.close();
		process.exit(127);
	});
	child.on("close", (code, signal) => {
		server.close(() => process.exit(code ?? (signal ? 137 : 0)));
		setTimeout(() => process.exit(code ?? 0), 2000).unref();
	});
});
