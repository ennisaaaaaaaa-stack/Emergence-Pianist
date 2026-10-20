// sandbox-stdout-test.mjs —— executor stdout 回收（沙箱路径交货单采集）+ driver 沙箱 tail 接线
// 单：retropad-v0编排器沙箱不回收stdout。病根：executor fd1=inherit，沙箱内 stdout（含 pi 会话
// 全文）打进 executor 控制台=编排器视角丢弃；driver 沙箱分支 exit.tail 恒空——裁决交货单
// （DONE/BLOCKED 行）无从采集。覆盖（验收逐条）：
//   A) 行为级断言（最硬）：captureStdout=true 真沙箱多行输出 → stdoutTail 字面含最后几行；
//      非零退场路照采（BLOCKED 行常伴 exit≠0）
//   B) 默认不变（阴性对照·灵魂）：不传 captureStdout → 返回 keys 与现状一致（code/signal/
//      journaledHosts），无 stdoutTail 字段——stdio 行为与现状等价
//   C) 上限防御：输出 ~10MB > 8MB 硬顶 → stdoutTail 长度 ≤ 上限、末行在、头部行已裁（截尾保留后半）
//   D) driver 接线：mock runSandboxed 返回 stdoutTail → 沙箱路径 exit.tail=尾部（slice(-4000) 同
//      直 spawn 语义）；调用点 captureStdout 默认开启；executor 无 stdoutTail（旧形状）→ tail="" 兼容不炸
//   E) 落盘 env 门控：PORTALK_SANDBOX_STDOUT_LOG 设路径 → 全文上盘（头尾都在），内存里只有截尾
// 运行：node test/sandbox-stdout-test.mjs（需 root + Landlock 内核，与 test/sandbox.test.mjs 同族；已挂 npm test）

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, total = 0;
function check(name, ok, extra) { total++; if (ok) pass++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra !== undefined && !ok ? " — " + extra : ""}`); }

if (process.getuid?.() !== 0) {
	console.log("FAIL 夹具：本测试需 root（轻档沙箱 unshare(CLONE_NEWNET)+降权；同族见 test/sandbox.test.mjs）");
	process.exit(1);
}

// ---- 夹具隔离：钥匙柜/记账/进度目录全指 tmp（driver 段 spawn 时 envOrVault 走柜路径，不碰生产） ----
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-stdout-"));
const credDir = path.join(tmpRoot, "cred");
const journalFile = path.join(tmpRoot, "cred-journal.jsonl");
const progressDir = path.join(tmpRoot, "progress");
for (const d of [credDir, progressDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(credDir, "coding-plan"), "sandbox-stdout-test-key-never-printed");
process.env.PORTALK_CRED_DIR = credDir;
process.env.PORTALK_CRED_JOURNAL = journalFile;
process.env.ORCH_PROGRESS_DIR = progressDir;
delete process.env.ZAI_CODING_CN_API_KEY; // 剥 ambient，走柜路径（值永不上输出）

const { runSandboxed, STDOUT_CAPTURE_LIMIT } = await import("../sandbox/executor.mjs");
const { RealDriver } = await import("../src/orchestrator/driver-real.mjs");

check("夹具：stdout 上限常量导出在位（8MB，测试与实现共用同一真值）", STDOUT_CAPTURE_LIMIT === 8 * 1024 * 1024);

// ============ A) 行为级断言：captureStdout=true → stdoutTail 字面含最后几行 ============
{
	const res = await runSandboxed({
		command: ["node", "-e", "console.log('so-line-1'); console.log('so-line-2'); console.log('so-line-3'); console.log('DONE 交货单采集');"],
		timeoutMs: 30_000,
		captureStdout: true,
	});
	check("A1：captureStdout=true → code=0 且 stdoutTail 字面含最后几行（交货单行在内）",
		res.code === 0 && res.stdoutTail.includes("so-line-2") && res.stdoutTail.includes("so-line-3") && res.stdoutTail.includes("DONE 交货单采集"),
		JSON.stringify({ code: res.code, tail: res.stdoutTail?.slice?.(-200) }));
	const resFail = await runSandboxed({
		command: ["node", "-e", "console.log('BLOCKED:环境: FOO_KEY 未配置'); process.exit(3);"],
		timeoutMs: 30_000,
		captureStdout: true,
	});
	check("A2：非零退场路照采（BLOCKED 行 + code=3 都在——交货单常伴 exit≠0）",
		resFail.code === 3 && resFail.stdoutTail.includes("BLOCKED:环境: FOO_KEY 未配置"),
		JSON.stringify({ code: resFail.code, tail: resFail.stdoutTail?.slice?.(-200) }));
}

// ============ B) 默认不变（阴性对照·灵魂）：旧形状断言锁死 ============
{
	// 阴性对照结构：captureStdout 传参处埋瓣（去掉默认 false）→ 本断言必红
	const res = await runSandboxed({
		command: ["node", "-e", "console.log('so-default-still-inherit');"],
		timeoutMs: 30_000,
	});
	check("B1：不传 captureStdout → 返回 keys 与现状一致（code/signal/journaledHosts，无 stdoutTail 字段，stdio 仍 inherit）",
		Object.keys(res).sort().join(",") === "code,journaledHosts,signal" && !("stdoutTail" in res),
		JSON.stringify(Object.keys(res)));
}

// ============ C) 上限防御：输出 ~10.4MB > 8MB 硬顶 → 截尾保留后半 ============
{
	const script = "for (let i = 0; i < 100000; i++) console.log('L' + String(i).padStart(6, '0') + '-' + 'x'.repeat(92)); console.log('L099999-END-MARKER');";
	const res = await runSandboxed({
		command: ["node", "-e", script],
		timeoutMs: 60_000,
		captureStdout: true,
	});
	const byteLen = Buffer.byteLength(res.stdoutTail ?? "", "utf8");
	check("C1：输出超上限 → stdoutTail 字节长度 ≤ STDOUT_CAPTURE_LIMIT（硬顶不爆内存）",
		res.code === 0 && byteLen <= STDOUT_CAPTURE_LIMIT,
		JSON.stringify({ code: res.code, byteLen, limit: STDOUT_CAPTURE_LIMIT }));
	check("C2：截尾保留后半（末行在、头部行已裁——交货单在输出末尾是设防理由）",
		res.stdoutTail.includes("L099999-END-MARKER") && !res.stdoutTail.includes("L000000-"),
		JSON.stringify({ hasEnd: res.stdoutTail.includes("L099999-END-MARKER"), headGone: !res.stdoutTail.includes("L000000-") }));
}

// ============ D) driver 接线：沙箱分支 tail 来自 executor 返回 ============
{
	const calls = [];
	const mockTail = "y".repeat(6000) + "\nDONE 交货单\n";
	const mockExec = async (o) => { calls.push(o); return { code: 0, signal: null, journaledHosts: [], stdoutTail: mockTail }; };
	const stubPath = path.join(tmpRoot, "stub-pi.mjs"); // 空壳：runSandboxed 已被 mock，入口从不真跑
	fs.writeFileSync(stubPath, "// stub-pi：driver 测试用，从不执行\n");
	const drv = new RealDriver({ cwd: tmpRoot, piBin: stubPath, progressDir, runSandboxed: mockExec });
	const rec = drv.spawn({ taskId: "t-so", minionId: "m-so", role: "审链临时工", prompt: "stub prompt" });
	const exit = await drv.rows.get("m-so").closed; // 返回值形状里 closed 被剥，走台账
	// 阴性对照结构：captureStdout 传参处埋瓣 → D1 必红；tail 填充处埋瓣（回 ""）→ D2 必红
	check("D1：driver 调用点 captureStdout 默认开启（编排器吃 tail 是本单目的）",
		calls.length === 1 && calls[0].captureStdout === true,
		JSON.stringify({ n: calls.length, opts: calls[0] && Object.keys(calls[0]) }));
	check("D2：沙箱路径 exit.tail 来自 executor stdoutTail 尾部（slice(-4000) 同直 spawn 语义、DONE 在窗内）",
		exit.code === 0 && exit.tail === mockTail.slice(-4000) && exit.tail.length === 4000 && exit.tail.includes("DONE 交货单"),
		JSON.stringify({ code: exit.code, len: exit.tail.length, hasDone: exit.tail.includes("DONE") }));
	// 旧形状兼容：注入的 executor 不带 stdoutTail（旧 mock/旧版本）→ tail 空串不炸
	const drvOld = new RealDriver({ cwd: tmpRoot, piBin: stubPath, progressDir, runSandboxed: async () => ({ code: 0, signal: null, journaledHosts: [] }) });
	const recOld = drvOld.spawn({ taskId: "t-so2", minionId: "m-so2", role: "审链临时工", prompt: "stub prompt" });
	const exitOld = await drvOld.rows.get("m-so2").closed;
	check("D3：executor 返回无 stdoutTail（旧形状）→ tail 空串兼容不炸", exitOld.code === 0 && exitOld.tail === "");
}

// ============ E) 落盘 env 门控：全文上盘、内存里只有截尾 ============
{
	const logFile = path.join(tmpRoot, "stdout-full.log");
	process.env.PORTALK_SANDBOX_STDOUT_LOG = logFile;
	try {
		const res = await runSandboxed({
			command: ["node", "-e", "console.log('LOG-HEAD-line'); console.log('LOG-TAIL-line');"],
			timeoutMs: 30_000,
			captureStdout: true,
		});
		const onDisk = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
		check("E1：PORTALK_SANDBOX_STDOUT_LOG 设路径 → stdout 全文落盘（头尾都在），返回值照带截尾",
			res.code === 0 && onDisk.includes("LOG-HEAD-line") && onDisk.includes("LOG-TAIL-line") && res.stdoutTail.includes("LOG-TAIL-line"),
			JSON.stringify({ onDisk: onDisk.slice(0, 100) }));
	} finally {
		delete process.env.PORTALK_SANDBOX_STDOUT_LOG;
	}
}

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
