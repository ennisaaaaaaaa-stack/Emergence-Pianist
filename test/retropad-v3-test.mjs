// t16-fix 活1+活2：retropad 运行性三修 + 收尾分身 prompt 验收测试（图纸 v3 三修公式/场景二三路分流）。
// 断言面（任务书验收逐条）：
//   活1-a 批次上限：MAX_PER_RUN=5 生效——喂 11 热点只盘 5（lastTs 旧先盘）；
//   活1-b 超时公式：timeout=180+60×批数——批5→480s、批1→240s（拉起行+任务书预算袋双面）；
//   活1-c 死亡落账：非法收工（模拟 kill）也写 state 带 verdict=failed（现状此路径不写）；
//        下一场批次自适应减半（11 热点只盘 2）；连续两死出声报修（log 行可断言）；
//   活2-prompt 收尾分身：--session 在场 → prompt 含三问+读 session 全文指令+三路分流
//        （spoor 路/坑区路实装、tideline 路留位静默跳过零写动作）；零热点+--session 不早退。
// 突变敏感（复验者亲手掰）：
//   - MAX_PER_RUN 拨回 10 → 11 热点只盘 5 断言红（拉起行变 10）；
//   - timeout 公式拆回固定 240 → 批5→480s 断言红；
//   - failFinish 的 writeRetroState 置空 → 阴性对照「state 存在且 verdict=failed」红；
//   - 收尾分身段删掉 → prompt 字符串断言全红。
// 零真钱铁律：ORCH_PI_BIN 全程指 stub，真 pi 拉起数=0。
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { spawn } from "node:child_process";

// ---- 夹具隔离（纪律）：凭证/进度/遥测/会话目录全指 tmp，不写生产路径 ----
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "retropad-v3-"));
const credDir = path.join(tmpRoot, "cred");
const journalFile = path.join(tmpRoot, "journal.jsonl");
const progressDir = path.join(tmpRoot, "progress");
const telemetryDir = path.join(tmpRoot, "telemetry");
const sessionsDir = path.join(tmpRoot, "sessions");
for (const d of [credDir, progressDir, telemetryDir, sessionsDir]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(credDir, "coding-plan"), "retropad-v3-key-never-printed");
process.env.PORTALK_CRED_DIR = credDir;
process.env.PORTALK_CRED_JOURNAL = journalFile;
process.env.ORCH_PROGRESS_DIR = progressDir;
process.env.PIANIST_TELEMETRY_DIR = telemetryDir;
process.env.PIANIST_SESSIONS_DIR = sessionsDir;
delete process.env.ZAI_CODING_CN_API_KEY;

let pass = 0, total = 0;
function check(name, ok, extra) {
	total++;
	if (ok) pass++;
	console.log(`${ok ? "PASS" : "FAIL"} ${name}${extra !== undefined && !ok ? " — " + extra : ""}`);
}

// ---- stub pi：nothing 正常收工 / hang 挂死等双时钟收（kill 面）----
const stubPath = path.join(tmpRoot, "stub-pi.mjs");
fs.writeFileSync(stubPath, `import fs from "node:fs";
import path from "node:path";
const mode = process.env.RETRO_STUB_MODE ?? "nothing";
const marker = process.env.RETRO_STUB_MARKER ?? "";
const dump = process.env.RETRO_STUB_DUMP ?? "";
const beat = (tool) => {
	const dir = process.env.PIANIST_TELEMETRY_DIR;
	if (!dir) return;
	const file = path.join(dir, (process.env.PIANIST_AGENT_ID ?? "orch-x") + "-" + new Date().toISOString().slice(0, 10) + ".jsonl");
	fs.appendFileSync(file, JSON.stringify({ v: 1, ts: new Date().toISOString(), kind: "tool_use", data: { tool, input: {}, isError: false } }) + "\\n");
};
if (dump) fs.writeFileSync(dump, process.argv.join("\\n"));
if (marker) fs.appendFileSync(marker, "spawned mode=" + mode + "\\n");
if (mode === "hang") { beat("pianist_bridge"); setInterval(() => {}, 1073741824); }
beat("pianist_bridge");
if (mode === "nothing") {
	console.log(JSON.stringify({ verdict: "nothing", health: "n/a", note: "本场没有值得记的" }));
	console.log("DONE");
	process.exit(0);
}
setInterval(() => {}, 1073741824);
`);
process.env.ORCH_PI_BIN = stubPath;

// ---- mock 壳：grimoire_darkzone（draft 名单拉取面） ----
const darkzoneText = "暗区点名(从未被push/expand):\\n（无 draft）\\n";
const mockShell = http.createServer((req, res) => {
	let body = "";
	req.on("data", (c) => { body += c; });
	req.on("end", () => {
		if (req.url === "/tools/invoke") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ status: 200, body: darkzoneText }));
			return;
		}
		res.writeHead(400, { "content-type": "application/json" });
		res.end(JSON.stringify({ status: 400, body: "nope" }));
	});
});
await new Promise((r) => mockShell.listen(18791, "127.0.0.1", r));

const ROOT = path.resolve(import.meta.dirname, "..");
const { readRetroState } = await import("../src/orchestrator/retro-trigger.mjs");

function runRetropad(argv, envOverrides = {}) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, [path.join(ROOT, "src", "retropad.mjs"), ...argv], {
			cwd: ROOT,
			env: { ...process.env, ...envOverrides },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let out = "", err = "";
		child.stdout.on("data", (d) => { out += d.toString(); });
		child.stderr.on("data", (d) => { err += d.toString(); });
		const guard = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 60_000);
		child.on("close", (code) => { clearTimeout(guard); resolve({ code, out, err }); });
	});
}

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
/** n 热点报告（lastTs 可控：i 越大越旧——lastTs 旧先盘断言用） */
function reportPath(n, { file = `rep-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`, oldestFirst = false } = {}) {
	const p = path.join(tmpRoot, file);
	fs.writeFileSync(p, JSON.stringify({
		v: 1, generatedAt: new Date().toISOString(), params: {},
		hotspots: Array.from({ length: n }, (_, i) => ({
			agent: "pianist-dev-1", occurrences: 9, convergence: 1,
			windowFp: `fp-${oldestFirst ? n - 1 - i : i}`,
			topExecShape: "bash:echo",
			firstTs: iso(3600_000), lastTs: iso(oldestFirst ? (n - i) * 60_000 : i * 60_000),
			evidence: { file: `/tmp/x${i}.jsonl`, line: 1, lastLine: 2 },
		})),
		errorHotspots: [],
	}));
	return p;
}

// ============ 1) 活1-a 批次上限：11 热点只盘 5（lastTs 旧先盘） ============
{
	const marker = path.join(tmpRoot, "m1");
	const state = path.join(tmpRoot, "s1.json");
	const dump = path.join(tmpRoot, "d1.txt");
	const r = await runRetropad(["--report", reportPath(11, { oldestFirst: true }), "--state", state, "--tickets", path.join(tmpRoot, "tk1.jsonl")], {
		RETRO_STUB_MODE: "nothing", RETRO_STUB_MARKER: marker, RETRO_STUB_DUMP: dump, PIANIST_SHELL_URL: "http://127.0.0.1:18791",
	});
	const sheet = fs.existsSync(dump) ? fs.readFileSync(dump, "utf8") : "";
	check("批次上限：exit 0 + 拉起行 11 热点只盘 5",
		r.code === 0 && /拉起复盘分身：5 重复热点 \+ 0 错误热点/.test(r.out),
		r.out.split("\n").filter((l) => l.includes("拉起") || l.includes("热点超")).join("|"));
	check("批次上限：截断出声（重复 11→5，剩下的留给下次）",
		r.out.includes("热点超批次上限") && r.out.includes("11→5"), r.out.slice(0, 400));
	check("批次上限：lastTs 旧先盘（fp-10 最旧先进任务书，fp-0 被截）",
		sheet.includes("fp-10") && !sheet.includes("fp-0"), sheet.split("\n").filter((l) => l.includes("fp-")).join(" | "));
}

// ============ 2) 活1-b 超时公式：批5→480s、批1→240s ============
{
	const state5 = path.join(tmpRoot, "s2a.json");
	const r5 = await runRetropad(["--report", reportPath(5), "--state", state5, "--tickets", path.join(tmpRoot, "tk2a.jsonl")], {
		RETRO_STUB_MODE: "nothing", RETRO_STUB_MARKER: path.join(tmpRoot, "m2a"), PIANIST_SHELL_URL: "http://127.0.0.1:18791",
	});
	check("超时公式：批5 → timeout=480s（180+60×5）",
		r5.code === 0 && r5.out.includes("timeout=480s"), r5.out.split("\n").filter((l) => l.includes("拉起") || l.includes("timeout")).join("|"));
	const state1 = path.join(tmpRoot, "s2b.json");
	const dump1 = path.join(tmpRoot, "d2b.txt");
	const r1 = await runRetropad(["--report", reportPath(1), "--state", state1, "--force", "--tickets", path.join(tmpRoot, "tk2b.jsonl")], {
		RETRO_STUB_MODE: "nothing", RETRO_STUB_MARKER: path.join(tmpRoot, "m2b"), RETRO_STUB_DUMP: dump1, PIANIST_SHELL_URL: "http://127.0.0.1:18791",
	});
	check("超时公式：批1 → timeout=240s（180+60×1）",
		r1.code === 0 && r1.out.includes("timeout=240s"), r1.out.split("\n").filter((l) => l.includes("拉起") || l.includes("timeout")).join("|"));
	check("超时公式：公式行自证（180+60×1=240s，非巧合撞固定 240）",
		r1.out.includes("公式 180+60×1=240s"), r1.out.split("\n").find((l) => l.includes("超时")) ?? "(无)");
	check("超时公式：批5 公式行自证（180+60×5=480s）",
		r5.out.includes("公式 180+60×5=480s"), r5.out.split("\n").find((l) => l.includes("超时")) ?? "(无)");
}

// ============ 3) 活1-c 死亡落账：kill 复盘分身 → state 存在且 verdict=failed（阴性对照核心） ============
{
	const state = path.join(tmpRoot, "s3.json");
	const r = await runRetropad(["--report", reportPath(3), "--state", state, "--timeout", "5", "--tickets", path.join(tmpRoot, "tk3a.jsonl")], {
		RETRO_STUB_MODE: "hang", RETRO_STUB_MARKER: path.join(tmpRoot, "m3"), PIANIST_SHELL_URL: "http://127.0.0.1:18791",
	});
	check("死亡落账：模拟 kill → exit 3 讣告路径", r.code === 3 && r.err.includes("分身死亡"),
		JSON.stringify({ code: r.code, err: r.err.slice(0, 200) }));
	const st = readRetroState(state);
	check("死亡落账：state 文件存在且 verdict=failed（现状此路径不写——改造后必写）",
		st.source === "json" && st.raw?.verdict === "failed" && st.raw?.failStreak === 1,
		JSON.stringify(st.raw));
	// ---- 第二死：模拟冷却窗过后的 due 再战（6h 后新事件到场景：lastRetroAt 拨回 7h 前，
	//      verdict=failed/failStreak=1 原样保留——减半与报修读的是它们，不是时间）----
	const prevRaw = readRetroState(state).raw;
	fs.writeFileSync(state, JSON.stringify({ ...prevRaw, lastRetroAt: new Date(Date.now() - 7 * 3600_000).toISOString() }, null, 2) + "\n");
	const marker4 = path.join(tmpRoot, "m4");
	const dump4 = path.join(tmpRoot, "d4.txt");
	const r2 = await runRetropad(["--report", reportPath(11, { oldestFirst: true }), "--state", state, "--timeout", "5", "--tickets", path.join(tmpRoot, "tk3.jsonl")], {
		RETRO_STUB_MODE: "hang", RETRO_STUB_MARKER: marker4, RETRO_STUB_DUMP: dump4, PIANIST_SHELL_URL: "http://127.0.0.1:18791",
	});
	check("两死报修：第二场开场出声（连续失败减半行）",
		r2.out.includes("批次自适应减半") && r2.out.includes("5→2"), r2.out.slice(0, 400));
	const st2 = readRetroState(state);
	check("两死报修：failStreak 累进到 2 且报修行出声",
		st2.raw?.verdict === "failed" && st2.raw?.failStreak === 2
		&& (r2.out.includes("报修") || r2.err.includes("报修"))
		&& /连续.*两场|连续 2 场|连续两/.test(r2.out + r2.err),
		JSON.stringify({ raw: st2.raw, tail: (r2.out + r2.err).slice(-400) }));
	check("两死报修：减半生效——11 热点只盘 2",
		/拉起复盘分身：2 重复热点/.test(r2.out), r2.out.split("\n").filter((l) => l.includes("拉起")).join("|"));
}

// ============ 4) 活2-prompt 收尾分身：--session → 三问+session 全文+三路分流 ============
{
	const corpseSession = path.join(tmpRoot, "corpse-session.jsonl");
	fs.writeFileSync(corpseSession, JSON.stringify({ type: "message", role: "user", content: "任务干了 XYZ" }) + "\n");
	const marker = path.join(tmpRoot, "m5");
	const dump = path.join(tmpRoot, "d5.txt");
	const state = path.join(tmpRoot, "s5.json");
	writeRecentState(state);
	const r = await runRetropad([
		"--report", reportPath(1), "--state", state, "--hook", "--session", corpseSession, "--project", "t16fix-proj", "--tickets", path.join(tmpRoot, "tk5.jsonl"),
	], {
		RETRO_STUB_MODE: "nothing", RETRO_STUB_MARKER: marker, RETRO_STUB_DUMP: dump, PIANIST_SHELL_URL: "http://127.0.0.1:18791",
	});
	const sheet = fs.existsSync(dump) ? fs.readFileSync(dump, "utf8") : "";
	check("收尾分身：--hook+--session 拉起（reason=hook，marker 物证）",
		r.code === 0 && r.out.includes("reason=hook") && fs.existsSync(marker), r.out.slice(0, 400));
	check("收尾分身：prompt 含读 session 全文指令（含尸体文件路径）",
		sheet.includes("读 session 全文") && sheet.includes(corpseSession), sheet.includes("收尾") ? "(段在)" : "(无收尾段)");
	check("收尾分身：三问在（编译掉什么判断/为何不心疼/何时交回判断）",
		sheet.includes("编译掉的是什么判断") && sheet.includes("为何不心疼") && sheet.includes("何时交回判断"),
		sheet.split("\n").filter((l) => l.includes("？") || l.includes("?")).slice(0, 6).join(" | "));
	check("收尾分身：三路分流在（spoor 路 spoor_journal 格式 mark 数据/判断 + 坑区路 mark 坑）",
		sheet.includes("spoor_journal") && sheet.includes("mark") && sheet.includes("数据") && sheet.includes("判断") && sheet.includes("坑")
		&& sheet.includes("t16fix-proj") && sheet.includes("非第一人称"),
		sheet.split("\n").filter((l) => l.includes("spoor") || l.includes("坑")).join(" | "));
	check("收尾分身：tideline 路留位静默跳过（字面在）",
		sheet.includes("tideline") && sheet.includes("留位静默跳过"),
		sheet.split("\n").filter((l) => l.includes("tideline")).join(" | "));
	check("收尾分身：tideline 零写入调用（prompt 无 tideline 写动作形状）",
		!/action[=:]\s*["']?tideline|tideline[_-]write|payload:\s*\{[^}]*tideline/i.test(sheet),
		"grep 应零命中");
	check("收尾分身：写入闸门照 v3（值得才写，没有就静默）",
		sheet.includes("值得才写") && sheet.includes("静默"), "");
}

// ============ 5) 零热点 + --session：尸体复盘不早退（成功路径沉淀不在错误传感器视野） ============
{
	const corpseSession = path.join(tmpRoot, "corpse-empty-hotspots.jsonl");
	fs.writeFileSync(corpseSession, JSON.stringify({ type: "message", role: "user", content: "零热点的成功场" }) + "\n");
	const marker = path.join(tmpRoot, "m6");
	const state = path.join(tmpRoot, "s6.json");
	writeRecentState(state); // 未到期 + 零热点：唯有 --hook 能拉
	const r = await runRetropad(["--report", reportPath(0), "--state", state, "--hook", "--session", corpseSession, "--tickets", path.join(tmpRoot, "tk6.jsonl")], {
		RETRO_STUB_MODE: "nothing", RETRO_STUB_MARKER: marker, PIANIST_SHELL_URL: "http://127.0.0.1:18791",
	});
	check("零热点+session：不早退，收尾分身照拉（marker 物证 + reason=hook）",
		r.code === 0 && fs.existsSync(marker) && r.out.includes("reason=hook"), r.out.slice(0, 400));
}

function writeRecentState(state) {
	fs.mkdirSync(path.dirname(state), { recursive: true });
	fs.writeFileSync(state, JSON.stringify({ v: 1, lastRetroAt: new Date(Date.now() - 60_000).toISOString(), runs: 1 }, null, 2) + "\n");
}

mockShell.close();
fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log(`PASS ${pass}/${total}`);
process.exit(pass === total ? 0 : 1);
