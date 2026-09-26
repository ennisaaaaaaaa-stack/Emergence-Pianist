// node 版本门（测试链这半）——同形状第三处溃疡：
//   engines>=22 + engine-strict 只挡 npm install，不挡 npm test 运行时；
//   部署 shell PATH 解析到 /usr/bin/node20 时，npm test 会死在 pi 包 undici 深处的
//   "webidl.util.markAsUncloneable is not a function"——尸检指向完全错误的楼层。
//   （前两颗钉：deploy/install-conductor.sh 安装时；src/conductor.mjs 常驻启动行自白。）
// 本门在链条最前：node 不达 >=22 → 大声死并说人话，不进任何测试。
const major = Number.parseInt(process.versions.node.split(".")[0], 10);
if (!(major >= 22)) {
	console.error(`[node-version-gate] PATH 里的 node 是 v${process.versions.node}，engines 契约要求 >=22——测试链不再往下跑。`);
	console.error("  死状预告：不设门时会炸在 undici/webidl 深处的 TypeError，不是那儿的错。");
	console.error("  正例：PATH=/.local/bin:$PATH npm test（本机已知 v22.22.2；或把 node>=22 排到 PATH 前列）。");
	process.exit(1);
}
console.log(`[node-version-gate] node v${process.versions.node} ✓（engines >=22）`);
