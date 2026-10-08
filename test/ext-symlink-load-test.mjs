// ext-symlink-load-test.mjs — 符号链接位加载回归测试（2026-10-08 生产事故疫苗）
//
// 事故：审批单给 pianist-tools.ts 加了 `import { BASH_RED_RES } from "../src/queue-core.mjs"`
// （相对 import）。repo 内测试全绿（jiti 从真身路径解析，../src/ 命中），但生产加载位是
// ~/.pi/agent/extensions/pianist-tools.ts 符号链接——pi 的 jiti 从【链接路径】解析相对
// import，../src/ 落到不存在的 /root/.pi/agent/src/，真 spawn 全断（conductor 抽卡连环死，
// 10/8 23:09-23:11 journal 三连）。修法=realpathSync 解回真身再 createRequire（extensions/
// pianist-tools.ts 头部注释有全案）。
//
// 本测试钉住链接位加载形状：mkdtemp 夹具复刻「真身 in repo + 符号链接在外部目录」布局，
// 用 pi 同款 jiti + pi 同款 alias 表（getAliases 的裸包名→绝对路径映射——生产加载靠它解析
// @sinclair/typebox），从链接位加载真 extension，断言：
//   1. 加载成功且 default factory 可执行（fail-fast：加载不了就是红，不是静默）
//   2. 审批钩子挂上、红区正则在手（从 queue-core 拿到的真尺子——force push 拦、ls 放行）
//
// 复刻依赖声明：alias 集是 pi@0.85.1 loader（dist/bundle getAliases）的子集快照——pi 升级
// 改了 alias 键集时本夹具要跟（到时这里先红，属于疫苗正常发作）。
// 纪律：不依赖 ~/.pi 真链接（部署面），夹具自造；不碰真工作区；零 token 零网络。
import { mkdtempSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createRequire } from "node:module";

const requireHere = createRequire(import.meta.url);
// 解析锚全走 repo 相对（test/ → 上一级），与既有 ext-test 同款生态
const repoRoot = dirname(dirname(new URL(import.meta.url).pathname));
const piPkgPath = requireHere.resolve("../node_modules/@earendil-works/pi-coding-agent/package.json");
const piRoot = dirname(piPkgPath);
const piRequire = createRequire(piPkgPath);
const jitiPath = requireHere.resolve("../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs");
const { createJiti: makeJiti } = await import(jitiPath);

// pi loader 同款 alias 子集（pianist-tools.ts 实际消费的裸包名）
const aliases = {
	"@sinclair/typebox": piRequire.resolve("typebox"),
	"@earendil-works/pi-coding-agent": join(piRoot, "index.js"),
};

// 夹具：外部目录 + 符号链接指回 repo 真身（复刻 ~/.pi/agent/extensions/ 布局）
const fx = mkdtempSync(join(tmpdir(), "ext-symlink-test-"));
try {
	mkdirSync(join(fx, "extensions"), { recursive: true });
	const linkPath = join(fx, "extensions", "pianist-tools.ts");
	symlinkSync(join(repoRoot, "extensions", "pianist-tools.ts"), linkPath);

	// 生产位 env 语义：无壳（降级路径）+ 固定 agent id（模块加载时读取，须在 import 前钉）
	process.env.PIANIST_AGENT_ID = "pianist-dev-1";
	delete process.env.PIANIST_SHELL_URL;

	const hooks = {};
	const tools = [];
	const pi = {
		on: (name, fn) => { (hooks[name] ??= []).push(fn); },
		registerTool: (t) => tools.push(t),
		appendEntry: () => {},
	};

	const jiti = makeJiti(import.meta.url, { moduleCache: false, alias: aliases });
	// 从【符号链接路径】加载——这是事故断言位：相对 import 回潮时这一行直接炸
	const mod = await jiti.import(linkPath, { default: true });
	const factory = typeof mod === "function" ? mod : mod.default;
	if (typeof factory !== "function") throw new Error("default export 不是 factory 函数");
	await factory(pi);

	// 审批线真有牙：红区拦（force push 是 BASH_RED_RES 常客）、良性放行
	if (!hooks["tool_call"]?.length) throw new Error("tool_call 钩子没挂上——审批线缺席");
	const red = await hooks["tool_call"][0]({ toolName: "bash", input: { command: "git push --force origin main" } });
	if (!red?.block) throw new Error(`红区没拦（force push 应 block）——尺子没接上，got: ${JSON.stringify(red)}`);
	const benign = await hooks["tool_call"][0]({ toolName: "bash", input: { command: "ls -la" } });
	if (benign !== undefined) throw new Error(`良性命令被拦：${JSON.stringify(benign)}`);

	console.log("ext-symlink-load-test PASS（链接位加载+红区拦截+良性放行）");
} finally {
	rmSync(fx, { recursive: true, force: true });
}
