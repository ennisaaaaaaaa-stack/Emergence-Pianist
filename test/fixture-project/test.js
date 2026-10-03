// 沙箱验收夹具测试：lodash 真装真用（沙箱内 npm install 后应全绿）
const assert = require("node:assert");
const os = require("node:os");
const _ = require("lodash");

assert.deepStrictEqual(_.chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
assert.strictEqual(typeof _.debounce, "function");
console.log(`fixture-ok: lodash@${_.VERSION} 在沙箱内可用，uid=${process.getuid()}，tmp=${os.tmpdir()}`);
