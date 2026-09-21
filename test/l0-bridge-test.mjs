// L0 桥接全流程测试（无 key 环境下验证到注入前一步）
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
const { L0Spine } = await jiti.import("../src/l0-spine.ts");

process.env.PIANIST_AGENT_ID = "pianist-dev-1";
const spine = new L0Spine({ bridgeTailMessages: 2 });

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "l0-bridge-")); // 自建自清，不依赖 /tmp 残留
const file1 = await spine.start(workDir);
console.log("session A:", file1);

const pack = await spine.bridgeToNewSession();
console.log("bridge pack:", pack ? "assembled" : "null");
console.log("session B:", spine.sessionFile);
console.log("T8 new session file differs:", spine.sessionFile !== file1);
console.log("T9 narrative non-empty:", typeof pack.narrative === "string" && pack.narrative.length > 0);
console.log("T10 skeleton has fields:", typeof pack.skeleton.toolCalls === "number");
console.log("T11 bridge count:", spine.bridgeCountTotal === 1);
console.log("inject error captured (expected without key):", spine.lastBridgeInjectError ? spine.lastBridgeInjectError.slice(0, 60) : "none");

await spine.dispose();
console.log("disposed clean");
