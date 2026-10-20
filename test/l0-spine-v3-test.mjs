// t16-fix 活3：95k 两增量 + 阈值可配验收测试（图纸 v3 增量①桥接归属壳/增量②桥接量实时算）。
// 断言面（任务书验收逐条）：
//   - 阈值可配：PIANIST_L0_CONTEXT_THRESHOLD / PIANIST_L0_NARRATIVE_START_LINE env 生效；
//     缺省不配 → 100_000 / 95_000 与现状一致（不同模型上下文尺寸不同，配置面必须有）；
//   - 区间切片：复盘（narrative 蒸馏）起笔记 coverage offset T_r；切换时桥接包 = (T_r, T_s]
//     全部原文——复盘后注入 N 条，桥接包恰含这 N 条不多不少（固定 20 条尾巴的形状必须消失）；
//   - 行为随配置变：同样注入量，env 小阈值起笔早（tail 有货），缺省阈值不起笔（当场补蒸馏全覆盖，tail 空）。
// 真机路径：真 pi session runtime（无 LLM 调用——sendCustomMessage triggerTurn:false 只落账不发起轮）。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createJiti } from "../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs";

let pass = 0, total = 0;
function check(name, ok, extra) {
	total++;
	if (ok) pass++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra !== undefined && !ok ? " — " + extra : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jiti = createJiti(import.meta.url);
const { L0Spine, defaultL0Config } = await jiti.import("../src/l0-spine.ts");

// ============ 1) 缺省值不配 → 与现状一致（100_000 / 95_000），固定尾巴配置面死掉 ============
{
	delete process.env.PIANIST_L0_CONTEXT_THRESHOLD;
	delete process.env.PIANIST_L0_NARRATIVE_START_LINE;
	const cfg = defaultL0Config();
	check("缺省：contextThreshold=100_000、narrativeStartLine=95_000（现状不变）",
		cfg.contextThreshold === 100_000 && cfg.narrativeStartLine === 95_000, JSON.stringify(cfg));
	check("缺省：固定尾巴配置面（bridgeTailMessages）死掉——区间切片接班",
		!("bridgeTailMessages" in cfg), JSON.stringify(cfg));
}

// ============ 2) env 设小阈值（200/190）→ 配置生效 + 切换行为随配置变 ============
{
	process.env.PIANIST_L0_CONTEXT_THRESHOLD = "200";
	process.env.PIANIST_L0_NARRATIVE_START_LINE = "190";
	const cfg = defaultL0Config();
	check("env：200/190 生效（阈值不写死——不同模型上下文尺寸不同）",
		cfg.contextThreshold === 200 && cfg.narrativeStartLine === 190, JSON.stringify(cfg));

	process.env.PIANIST_AGENT_ID = "pianist-dev-1";
	const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "l0-v3-env-"));
	const spine = new L0Spine(); // env 经 defaultL0Config 进构造
	await spine.start(workDir);
	const session = spine.runtime.session;

	// 消息①：~300 token（>190 起笔线）→ 蒸馏起笔，coverage offset 记 T_r=1
	await session.sendCustomMessage({
		customType: "note",
		content: [{ type: "text", text: "A".repeat(1200) }],
		display: "big",
	}, { triggerTurn: false });
	await sleep(150); // onEvent 异步——等蒸馏落账

	// 消息②③④：复盘起笔之后的 N=3 条新原文
	for (let i = 1; i <= 3; i++) {
		await session.sendCustomMessage({
			customType: "note",
			content: [{ type: "text", text: `after-${i}` }],
			display: "small",
		}, { triggerTurn: false });
	}
	await sleep(100);

	const pack = await spine.bridgeToNewSession();
	check("区间切片：桥接包恰含复盘后的 3 条（不多不少——含起笔前那条就是旧尾巴形状）",
		pack != null && Array.isArray(pack.tailMessages) && pack.tailMessages.length === 3,
		`len=${pack?.tailMessages?.length}`);
	check("区间切片：切片内容=(T_r, T_s]——after-1..after-3 原文精确搬运，消息①不在包里（零重叠）",
		pack.tailMessages.every((m) => JSON.stringify(m).includes("after-"))
		&& !pack.tailMessages.some((m) => JSON.stringify(m).includes("AAAA")),
		JSON.stringify(pack.tailMessages.map((m) => m.content)));
	check("区间切片：coverageOffset=T_r=1（蒸馏恰覆盖第 0..0 条——零缝隙零重叠同源两数）",
		pack.coverageOffset === 1, `coverageOffset=${pack?.coverageOffset}`);
	check("区间切片：narrative 在（蒸馏覆盖前段）+ 骨架索引在",
		typeof pack.narrative === "string" && pack.narrative.length > 0 && pack.skeleton.toolCalls >= 0);
	check("切换原子性：新 session 文件与父不同、桥接计数=1",
		spine.sessionFile !== pack.parentSessionFile && spine.bridgeCountTotal === 1);
	await spine.dispose();
	fs.rmSync(workDir, { recursive: true, force: true });

	// ---- 缺省阈值对照：同样注入量（~300 token << 95k）→ 不起笔，切换时当场补蒸馏全覆盖 ============
	delete process.env.PIANIST_L0_CONTEXT_THRESHOLD;
	delete process.env.PIANIST_L0_NARRATIVE_START_LINE;
	const workDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "l0-v3-dflt-"));
	const spine2 = new L0Spine();
	await spine2.start(workDir2);
	const session2 = spine2.runtime.session;
	await session2.sendCustomMessage({
		customType: "note",
		content: [{ type: "text", text: "B".repeat(1200) }],
		display: "big",
	}, { triggerTurn: false });
	for (let i = 1; i <= 3; i++) {
		await session2.sendCustomMessage({
			customType: "note",
			content: [{ type: "text", text: `after-${i}` }],
			display: "small",
		}, { triggerTurn: false });
	}
	await sleep(100);
	const pack2 = await spine2.bridgeToNewSession();
	check("行为随配置变：缺省阈值同注入不起笔——切换当场补蒸馏全覆盖（coverageOffset=4、tail 空）",
		pack2.coverageOffset === 4 && pack2.tailMessages.length === 0,
		`coverageOffset=${pack2?.coverageOffset} tail=${pack2?.tailMessages?.length}`);
	check("行为随配置变：narrative 仍在（当场补的蒸馏照产）", typeof pack2.narrative === "string" && pack2.narrative.length > 0);
	await spine2.dispose();
	fs.rmSync(workDir2, { recursive: true, force: true });
}

console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
