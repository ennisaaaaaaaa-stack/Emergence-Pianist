// test/engine-registry.test.mjs —— T12 契约测试：重档接口位（不施工，只测契约行为）
// 覆盖：①注册表两档在册且状态正确 ②缺省 engine=轻档（向后兼容）③microvm 接口位大声拒绝不静默降级
// ④未知引擎名大声拒绝 ⑤契约形状：runSandboxed 的签名与返回值约定（轻档实测一炮）
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { ENGINES, resolveEngine } from "../sandbox/engine-registry.mjs";

let pass = 0, total = 0;
const check = (name, ok) => { total++; if (ok) { pass++; console.log(`PASS ${name}`); } else console.log(`FAIL ${name}`); };

// ① 注册表形状
check("注册表：两档在册（kernel_primitives + microvm）", !!ENGINES.kernel_primitives && !!ENGINES.microvm);
check("注册表：轻档 status=active", ENGINES.kernel_primitives.status === "active");
check("注册表：重档 status=reserved（接口位未施工）", ENGINES.microvm.status === "reserved");
check("注册表：重档无实现挂载（run 空）", ENGINES.microvm.run === undefined);

// ② 缺省 engine = 轻档（既有策略文件零改动兼容）
{
	const r = resolveEngine({});
	check("缺省 engine：resolveEngine({}) → 轻档", r.id === "kernel_primitives");
}

// ③ microvm 接口位：大声拒绝 + 报错里指路（不静默降级到轻档）
{
	let err = null;
	try { resolveEngine({ engine: "microvm" }); } catch (e) { err = e; }
	check("microvm：大声拒绝（throw 非 return）", err instanceof Error);
	check("microvm：报错含启用条件指路（docs §六）", /docs\/t9-microvm-scope\.md/.test(err?.message ?? ""));
	check("microvm：报错明说怎么切回轻档", /删掉 engine 字段|kernel_primitives/.test(err?.message ?? ""));
}

// ④ 未知引擎名
{
	let err = null;
	try { resolveEngine({ engine: "docker" }); } catch (e) { err = e; }
	check("未知引擎：大声拒绝并列出在册名单", err instanceof Error && /kernel_primitives/.test(err.message));
}

// ⑤ 策略文件加载链路真跑：default 策略（无 engine 字段）过 executor 真执行
// （命令用 PATH 里的 node 相对名——沙箱内 /.hermes 对 nobody 不可穿越，绝对路径会 EACCES，这正是 Landlock 在工作）
{
	const r = spawnSync(
		process.execPath,
		["sandbox/run-sandboxed.mjs", "--policy", "sandbox/policies/default.policy.json", "--", "node", "-e", "console.log('t12-ok')"],
		{ encoding: "utf8", timeout: 60_000, cwd: "REPO_HOME" },
	);
	check("契约链路：default 策略（无 engine 字段）真跑成功", r.status === 0 && r.stdout.includes("t12-ok"));
}

// ⑥ 带 engine:kernel_primitives 的策略同样放行（显式声明合法）
{
	const tmpPolicy = "/tmp/t12-explicit-engine.policy.json";
	const p = JSON.parse(fs.readFileSync("sandbox/policies/default.policy.json", "utf8"));
	p.engine = "kernel_primitives";
	fs.writeFileSync(tmpPolicy, JSON.stringify(p));
	const r = spawnSync(
		process.execPath,
		["sandbox/run-sandboxed.mjs", "--policy", tmpPolicy, "--", "node", "-e", "console.log('t12-explicit')"],
		{ encoding: "utf8", timeout: 60_000, cwd: "REPO_HOME" },
	);
	check("契约链路：显式 engine:kernel_primitives 放行真跑", r.status === 0 && r.stdout.includes("t12-explicit"));
	fs.rmSync(tmpPolicy, { force: true });
}

// ⑦ 带 engine:microvm 的策略在 CLI 全链路上同样大声拒绝（exit 125 = runSandboxed throw）
{
	const tmpPolicy = "/tmp/t12-microvm.policy.json";
	const p = JSON.parse(fs.readFileSync("sandbox/policies/default.policy.json", "utf8"));
	p.engine = "microvm";
	fs.writeFileSync(tmpPolicy, JSON.stringify(p));
	const r = spawnSync(
		process.execPath,
		["sandbox/run-sandboxed.mjs", "--policy", tmpPolicy, "--", "true"],
		{ encoding: "utf8", timeout: 60_000, cwd: "REPO_HOME" },
	);
	check("契约链路：engine:microvm CLI 全链路拒绝（非 0 退出）", r.status === 125 && /接口位未施工/.test(r.stderr));
	fs.rmSync(tmpPolicy, { force: true });
}

console.log(`${pass}/${total} passed`);
if (pass !== total) process.exit(1);
