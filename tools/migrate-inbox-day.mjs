#!/usr/bin/env node
// migrate-inbox-day.mjs — F2 收件箱按天清·上线迁移（施工读法 A，spec：docs/f2-inbox-ttl-spec-v0.2.1.md 实现面 1/验收 7）
//
// 干什么：扫壳的存量 pending 审批卡，无 day 的补打 day=部署日（壳侧真钟 nowJstDay()——部署日
// 不是注入位，真壳迁移没有假钟一说）。补打后当日不清、次日起自然过期（不是当庭清杀）。
// 幂等：已有 day 的卡不动，二次跑报 0。清理判定在运行时（sweepExpired，day < today），
// 本工具只补 day 字段、不做任何 deny。
//
// 为什么是迁移不是运行时 fallback（施工读法钉 A 禁 B，hui #1088）：B 读法（entry.day ?? today）
// 下 undefined 条目每天都被视为 today，day < today 恒假，存量卡永生——而 F2 的第一真实用户正是
// 10/12-13 那族跨日残留死卡，动机与实现打架。本工具是 A 读法的唯一施工件。
//
// 用法：node tools/migrate-inbox-day.mjs [--url <shell-url>] [--dry-run]
//   --url     缺省 PIANIST_SHELL_URL ?? http://127.0.0.1:8770
//   --dry-run 只报不写（壳侧零改动）
// 通道：GET /approvals/pending（扫，壳侧 pending() 只给 pending 态）→ POST /approvals/backfill-day
//   （补打，壳侧真钟+审计落账 migrate 行）
// 时机纪律：真壳存量卡的迁移时机是收口人的活——本工具只交手段，不在任何测试/CI 里对真壳跑。

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const urlIdx = args.indexOf("--url");
const BASE = (urlIdx >= 0 && args[urlIdx + 1] && !args[urlIdx + 1].startsWith("--"))
	? args[urlIdx + 1].replace(/\/$/, "")
	: (process.env.PIANIST_SHELL_URL ?? "http://127.0.0.1:8770").replace(/\/$/, "");

async function main() {
	let cards;
	try {
		const res = await fetch(`${BASE}/approvals/pending`, { signal: AbortSignal.timeout(5000) });
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const out = await res.json();
		cards = Array.isArray(out?.pending) ? out.pending : [];
	} catch (e) {
		console.error(`[migrate-inbox-day] 够不着壳（${BASE}/approvals/pending）：${e?.message ?? e}——先确认壳在跑、--url 指对。不迁移不退出 0`);
		process.exit(1);
	}
	const legacy = cards.filter((c) => c?.status === "pending" && typeof c?.day !== "string");
	console.log(`[migrate-inbox-day] 扫壳 ${BASE}：pending ${cards.length} 张，其中无 day 存量卡 ${legacy.length} 张`);
	if (!legacy.length) {
		console.log(`[migrate-inbox-day] 无可迁移（幂等：pending 全已有 day）——收工`);
		return;
	}
	const ids = legacy.map((c) => c.id);
	if (DRY) {
		console.log(`[migrate-inbox-day] [dry-run] 将补打 day=部署日（真钟）：${ids.join(" ")}——不写壳，零改动`);
		return;
	}
	let out;
	try {
		const res = await fetch(`${BASE}/approvals/backfill-day`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		out = await res.json();
	} catch (e) {
		console.error(`[migrate-inbox-day] 补打失败（${BASE}/approvals/backfill-day）：${e?.message ?? e}`);
		process.exit(1);
	}
	const stamped = Array.isArray(out?.backfilled) ? out.backfilled : [];
	console.log(`[migrate-inbox-day] 补打完成：day=${out?.day}（部署日，真钟），壳侧实打 ${stamped.length} 张——${stamped.map((b) => b.id).join(" ")}（审计账各落 migrate 行）`);
	if (stamped.length !== legacy.length) {
		console.warn(`[migrate-inbox-day] 注意：扫到 ${legacy.length} 张但实打 ${stamped.length} 张——差额是补打竞窗里被裁决/已有 day 的卡（幂等面，重跑即对齐）`);
	}
}
main();
