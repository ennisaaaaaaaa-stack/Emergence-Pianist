/**
 * heartbeat.mjs — 心跳双源 watcher（任务编排器⑧ 第一铲·真身接线）
 *
 * 是什么：把分身的「还活着且在动」喂给编排器的机械源。双源（拍板表#4）：
 *   ① 会话文件 mtime——发车时刻起 [发车-lockSkewMs, +lockWindowMs]（缺省 [-5s, +150s]，
 *      驱动器模板 v2.1 同款不对称窗）在会话目录**树**里锁定本分身的 session 文件，
 *      之后 mtime 推进=beat；
 *   ② 遥测 jsonl tail——尾部追加的事件行逐条喂引擎（走 engine.telemetryEvent 全路径，
 *      坑账匹配顺路生效），事件缺 ts 时以文件 mtime 兜底。
 * 纪律：mtime/事件推进才喂 beat（推进本身即心跳，不推进不编造）；**不轮询分身进程**——
 * 探活是 driver.isAlive 的事，双源都没有 → 不喂，静默钟自己会响（这正是它存在的意义：
 * 监督器不依赖分身自觉，分身不写心跳照样被静默钟收走）。
 *
 * 源①两坑（2026-10-10 修，live-e2e 实测缺口）：
 *   - pi 会话落 `--cwd-sanitized--/` 子目录（顶层零 .jsonl）——单层 readdirSync 永远锁空，
 *     必须递归扫树（受 maxScanDepth/最旧边界约束，544 文件的树不许无界游走）；
 *   - 对称 ±lockWindowMs 会误锁发车前残留的冒烟测试会话（v2.1 教训在编排器侧的同款）——
 *     下沿收紧到 -lockSkewMs（发车前 5s 内的名容忍，更早的不锁）。
 *
 * 文件路径全可注入（env 或构造参，不写死生产路径）：
 *   遥测目录 = PIANIST_TELEMETRY_DIR（shell.mjs 同款）；会话目录 = PIANIST_SESSIONS_DIR（缺省 ~/.pi/agent/sessions）。
 *
 * 纯文件面：poll() 幂等可手驱（测试用），start()/stop() 挂 setInterval（生产用）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** session 文件名时间戳 → ms（形状：2026-09-19T14-49-30-013Z_<uuid>.jsonl，pi 落盘惯例） */
const SESSION_NAME_TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z[_-]/;
function sessionStartMs(fileName) {
	const m = SESSION_NAME_TS_RE.exec(fileName);
	if (!m) return null;
	return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
}

export function defaultSessionsDir() {
	return process.env.PIANIST_SESSIONS_DIR ?? path.join(os.homedir(), ".pi", "agent", "sessions");
}

/**
 * @param {object} opts
 * @param {(minionId: string, ev: object) => void} [opts.onBeat] beat 回调（runtime 接到 engine.telemetryEvent）
 * @param {number} [opts.lockWindowMs] 会话文件锁定窗口上沿（发车后 +150s；缺省 150_000）
 * @param {number} [opts.lockSkewMs]   会话文件锁定窗口下沿（发车前 -5s——容忍挂钟微偏，不锁残留；缺省 5_000）
 * @param {number} [opts.maxScanDepth] 递归扫树最大深度（子目录层数；缺省 2——pi 落 `--cwd--/` 一层足够）
 */
export class HeartbeatWatcher {
	constructor({ onBeat = () => {}, lockWindowMs = 150_000, lockSkewMs = 5_000, maxScanDepth = 2, rescanMs = 5_000 } = {}) {
		this.onBeat = onBeat;
		this.lockWindowMs = lockWindowMs;
		this.lockSkewMs = lockSkewMs;
		this.maxScanDepth = maxScanDepth;
		this.rescanMs = rescanMs; // 滚动重扫最小间隔（5s）：等锁不是自旋——500ms 的 poll 轮里 9/10 轮不扫树
		this.minions = new Map(); // minionId → { spawnAt, telemetryFile, sessionDir, sessionFiles[], seenMtime:Map, telSize, telPartial, lastRescanAt }
		this.timer = null;
	}

	/**
	 * 登记一个分身的心跳源。两个源都可空（双源都没有=不喂，静默钟兜底）。
	 * @param {object} p { spawnAt: ms, telemetryFile?: string|null, sessionDir?: string|null }
	 */
	watch(minionId, { spawnAt = Date.now(), telemetryFile = null, sessionDir = null } = {}) {
		const st = {
			spawnAt,
			telemetryFile: telemetryFile ?? null,
			sessionDir: sessionDir ?? null,
			sessionFiles: [],
			seenMtime: new Map(),
			telSize: 0,
			telPartial: "",
			lastRescanAt: 0,
		};
		// 源①锁定：发车时刻 ±lockWindow 内起始的 session 文件（锁一次，之后只盯这些文件）
		if (st.sessionDir) st.sessionFiles = this._lockSessionFiles(st.sessionDir, spawnAt);
		this.minions.set(minionId, st);
		return st;
	}

	_lockSessionFiles(sessionDir, spawnAt) {
		// 递归扫树（受深度与最旧边界约束）+ 不对称锁定窗 [发车-lockSkewMs, +lockWindowMs]：
		// pi 会话落 --cwd-sanitized--/ 子目录（顶层零 .jsonl），单层扫=永远锁空（live-e2e 缺口）；
		// 对称下沿 ±lockWindowMs 会误锁发车前残留（v2.1 教训同款）。
		const files = [];
		const walk = (dir, depth) => {
			let entries;
			try {
				entries = fs.readdirSync(dir, { withFileTypes: true });
			} catch {
				return; // 目录不存在/瞬态不可读=源①缺席（诚实：不喂），不造
			}
			for (const e of entries) {
				const full = path.join(dir, e.name);
				if (e.isDirectory()) {
					if (depth < this.maxScanDepth) walk(full, depth + 1);
				} else if (e.isFile() && e.name.endsWith(".jsonl")) {
					files.push(full);
				}
			}
		};
		walk(sessionDir, 0);
		const lo = spawnAt - this.lockSkewMs;
		const hi = spawnAt + this.lockWindowMs;
		return files
			.map((file) => {
				const ms = sessionStartMs(path.basename(file));
				return ms != null && ms >= lo && ms <= hi ? file : null;
			})
			.filter(Boolean);
	}

	locked(minionId) {
		const st = this.minions.get(minionId);
		return st ? [...st.sessionFiles] : [];
	}

	forget(minionId) {
		return this.minions.delete(minionId);
	}

	/** 推进一轮：有推进才产 beat（幂等——同状态重复 poll 不重复喂）。返回本轮 beats 便于测试断言。 */
	poll() {
		const beats = [];
		for (const [minionId, st] of this.minions) {
			// 源②：遥测 tail——新完整行逐条喂（截断尾行留到下一轮拼）
			if (st.telemetryFile) {
				try {
					const fi = fs.statSync(st.telemetryFile);
					if (fi.size > st.telSize) {
						const fh = fs.openSync(st.telemetryFile, "r");
						const len = fi.size - st.telSize;
						const buf = Buffer.alloc(len);
						fs.readSync(fh, buf, 0, len, st.telSize);
						fs.closeSync(fh);
						// telSize 永远停在完整行边界（下轮从 partial 行首重读），chunk 自含 partial，不前置拼接
						const text = buf.toString("utf8");
						const lines = text.split("\n");
						st.telPartial = lines.pop() ?? ""; // 末段无换行=截断尾，攒着
						st.telSize = fi.size - Buffer.byteLength(st.telPartial, "utf8");
						for (const line of lines) {
							const t = line.trim();
							if (!t) continue;
							let ev = null;
							try { ev = JSON.parse(t); } catch { /* 坏行跳过（遥测流截尾是常态，地板不许因一行坏数据拒出） */ }
							if (!ev || typeof ev !== "object") continue;
							const ts = typeof ev.ts === "string" && ev.ts ? ev.ts : new Date(fi.mtimeMs).toISOString();
							const beat = { ...ev, ts, source: "telemetry" };
							beats.push({ minionId, source: "telemetry", ev: beat });
						}
					}
				} catch { /* 文件还没出现/瞬态不可读=源②暂缺席，不喂不炸 */ }
			}
			// 源①滚动锁定（live 缺口 2026-10-11：真 pi 首行延迟可达 ~45s，一次性 readdir 在
			// onSpawn 时刻扫不到还没落盘的会话文件 → sessionFiles 恒空 → 源①结构性缺席）：
			// 未锁到且锁窗未关 → 限频重扫（rescanMs 间隔——等锁不是自旋）；锁到或窗关即停。
			// 窗语义不变（不对称下沿防误锁）。
			if (st.sessionDir && st.sessionFiles.length === 0 && Date.now() < st.spawnAt + this.lockWindowMs) {
				if (Date.now() - st.lastRescanAt >= this.rescanMs) {
					st.lastRescanAt = Date.now();
					st.sessionFiles = this._lockSessionFiles(st.sessionDir, st.spawnAt);
				}
			}
			// 源①：session 文件 mtime——推进即 beat
			for (const file of st.sessionFiles) {
				try {
					const mtimeMs = fs.statSync(file).mtimeMs;
					if (mtimeMs > (st.seenMtime.get(file) ?? st.spawnAt)) {
						st.seenMtime.set(file, mtimeMs);
						const ev = { v: 1, ts: new Date(mtimeMs).toISOString(), kind: "session_mtime", source: "session" };
						beats.push({ minionId, source: "session", ev });
					}
				} catch { /* 文件被清=不再喂这条源 */ }
			}
		}
		for (const b of beats) this.onBeat(b.minionId, b.ev);
		return beats;
	}

	start(pollMs = 500) {
		this.stop();
		this.timer = setInterval(() => this.poll(), pollMs);
		return this.timer;
	}

	stop() {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}
}
