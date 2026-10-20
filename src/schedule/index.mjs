/**
 * index.mjs — schedule 模块门面（2026-10-12 schedule-bone 施工）
 *
 * conductor 消费接线只认这个入口：存储（store）+ 评估器纯函数（evaluator）。
 * spec：docs/schedule-spec-v0.1.md（六条拍板，不重开）。
 */

export {
	PERMISSION_TIERS,
	DEFAULT_PERMISSION_TIER,
	DEFAULT_ACTIVE_HOURS,
	DEFAULT_ENTRY_STATUS,
	TERMINAL_ENTRY_STATUSES,
	ACTIVE_ENTRY_STATUSES,
	toMs,
	beijingMinuteOfDay,
	beijingHHMM,
	parseActiveHours,
	resolveActiveWindow,
	resolvePermissionTier,
	scheduleEntryRisk,
	evaluateFireGate,
	evaluateSchedule,
} from "./evaluator.mjs";

export {
	emptySchedule,
	readSchedule,
	writeSchedule,
	readActiveHoursFile,
	makeEntry,
} from "./store.mjs";
