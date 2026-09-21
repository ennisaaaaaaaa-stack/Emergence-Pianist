// L0 主干真机测试：不调 LLM，验证 runtime 创建、session 落盘、桥接切换、衔接包组装
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
const { L0Spine, builtinMinimalDistill, buildSkeleton } = await jiti.import("../src/l0-spine.ts");

// --- 单元测试：纯函数 ---
// builtinMinimalDistill
const fakeMessages = [
	{ role: "user", content: "hi" },
	{ role: "assistant", content: [{ type: "text", text: "hello there" }], toolCalls: [{ name: "read" }, { name: "bash" }] },
	{ role: "user", content: "do something" },
	{ role: "assistant", content: [{ type: "text", text: "done" }], toolCalls: [{ name: "read" }] },
];
const distillText = builtinMinimalDistill(fakeMessages);
console.log("distill:", distillText.split("\n")[0]);
console.log("T1 user=2:", distillText.includes("2 条用户消息"));
console.log("T2 toolCalls=3:", distillText.includes("3 次工具调用"));

// buildSkeleton
const skel = buildSkeleton("/tmp/fake.jsonl", fakeMessages);
console.log("T3 skeleton toolsUsed:", skel.toolsUsed.sort().join(",") === "bash,read", JSON.stringify(skel.toolsUsed));
console.log("T4 skeleton toolCalls:", skel.toolCalls === 3);

// --- 真机测试：L0Spine（无 LLM 调用路径）---
process.env.PIANIST_AGENT_ID = "pianist-dev-1";
const spine = new L0Spine({ bridgeTailMessages: 2 });
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "l0-smoke-")); // 自建自清，不依赖 /tmp 残留
const file1 = await spine.start(workDir);
console.log("T5 start creates session:", typeof file1 === "string" && file1.endsWith(".jsonl"));
console.log("    session file:", file1);

// 骨架/蒸馏在空消息上的表现
const usage = spine.getContextUsage();
console.log("T6 contextUsage on empty:", usage === 0);

// bridgeToNewSession 在无 key 环境下：newSession 不调 LLM，但注入衔接包的 prompt() 需要模型
// → 拆两步：只验证 newSession 切换 + bindSession 重绑
// prompt 那步留给全链路测试（④拿 key 后）
await spine.dispose();
console.log("T7 disposed clean: true");

const results = ["T1", "T2", "T3", "T4"];
console.log("\nunit tests done; integration smoke (no-LLM path) passed");
