#!/usr/bin/env node
// credentials/broker.mjs —— 全代发（纯度第一档，key 不进 agent 进程文本）：
// 读存储 → 替换 header/body 模板里的 {VALUE} → spawn curl（天然吃 env 代理）→ 只打印响应 body。
// 值永不上进程命令行：header 走 curl 的 -H @file、body 走 --data-binary @file（600 权限临时文件，用完即删）。
// 打印前过 scanText 保险带：输出里若意外含值，替换成 [credential:<名字>] 再出门。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { readValue } from "./store.mjs";
import { scanText } from "./scan.mjs";
import { authorize } from "./tiers.mjs";
import { journal } from "./journal.mjs";

const argv = process.argv.slice(2);
let name = null,
	url = null,
	method = "POST",
	body;
const headers = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--name") name = argv[++i];
	else if (argv[i] === "--url") url = argv[++i];
	else if (argv[i] === "--method") method = argv[++i];
	else if (argv[i] === "--header") headers.push(argv[++i]);
	else if (argv[i] === "--body") body = argv[++i];
	else {
		console.error(`broker: 未知参数 ${argv[i]}`);
		process.exit(2);
	}
}
if (!name || !url || headers.length === 0) {
	console.error(
		"用法: node credentials/broker.mjs --name <钥匙名> --url <URL> [--method POST] [--header 'Authorization: Bearer {VALUE}'] [--body <str>]",
	);
	process.exit(2);
}

const verdict = await authorize(name, { intent: `broker ${method} ${url}` });
if (!verdict.allowed) {
	console.error(`[broker] 拒绝使用钥匙 ${name}：${verdict.reason}`);
	process.exit(3);
}

const value = readValue(name);
const tmpFiles = [];
function tmpFile(tag, content) {
	const p = path.join(os.tmpdir(), `portalk-cred-${tag}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
	fs.writeFileSync(p, content, { mode: 0o600 });
	fs.chmodSync(p, 0o600);
	tmpFiles.push(p);
	return p;
}

const args = ["-sS", "--max-time", "60", "-X", method];
args.push("-H", `@${tmpFile("header", headers.map((h) => h.replaceAll("{VALUE}", value)).join("\n"))}`);
if (body !== undefined) args.push("--data-binary", `@${tmpFile("body", body.replaceAll("{VALUE}", value))}`);

journal("use-broker", { name, tier: verdict.tier, method, host: new URL(url).host });

let out = "",
	err = "",
	exitCode = 0;
try {
	await new Promise((resolve) => {
		const child = spawn("curl", [...args, url], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (err += d));
		child.on("error", (e) => {
			console.error(`[broker] curl 启动失败：${e.message}`);
			exitCode = 127;
			resolve();
		});
		child.on("close", (c) => {
			exitCode = c ?? 127;
			resolve();
		});
	});
} finally {
	for (const p of tmpFiles) fs.rmSync(p, { force: true }); // 临时文件用完即删
}

if (exitCode === 0) {
	process.stdout.write(scanText(out)); // 保险带：只打印响应 body，且先过全量值扫描
} else {
	if (err.trim()) console.error(`[broker] ${scanText(err.trim())}`);
	process.exit(exitCode);
}
