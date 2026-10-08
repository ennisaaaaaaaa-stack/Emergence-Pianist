/**
 * heartbeat.mjs — 心跳双源 watcher（任务编排器⑧ 第一铲·真身接线）
 *
 * 是什么：把分身的「还活着且在动」喂给编排器的机械源。双源（拍板表#4）：
 *   ① 会话文件 mtime——发车时刻 ±lockWindowMs（默认 150s，skill 派活驱动器 v2 的方子）
 *      在会话目录里锁定本分身的 session 文件，之后 mtime 推进=beat；
 *   ② 遥测 jsonl tail——尾部追加的事件行逐条喂引擎（走 engine.telemetryEvent 全路径，
 *      坑账匹配顺路生效），事件缺 ts 时以文件 mtime 兜底。
 * 纪律：mtime/事件推进才喂 beat（推进本身即心跳，不推进不编造）；**不轮询分身进程**——
 * 探活是 driver.isAlive 的事，双源都没有 → 不喂，静默钟自己会响（这正是它存在的意义：
 * 监督器不依赖分身自觉，分身不写心跳照样被静默钟收走）。
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
 * @param {number} [opts.lockWindowMs] 会话文件锁定窗口（缺省 150s）
 */
export class HeartbeatWatcher {
	constructor({ onBeat = () => {}, lockWindowMs = 150_000 } = {}) {
		this.onBeat = onBeat;
		this.lockWindowMs = lockWindowMs;
		this.minions = new Map(); // minionId → { spawnAt, telemetryFile, sessionDir, sessionFiles[], seenMtime:Map, telSize, telPartial }
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
		};
		// 源①锁定：发车时刻 ±lockWindow 内起始的 session 文件（锁一次，之后只盯这些文件）
		if (st.sessionDir) st.sessionFiles = this._lockSessionFiles(st.sessionDir, spawnAt);
		this.minions.set(minionId, st);
		return st;
	}

	_lockSessionFiles(sessionDir, spawnAt) {
		let names;
		try {
			names = fs.readdirSync(sessionDir);
		} catch {
			return []; // 目录不存在=源①缺席（诚实：不喂），不造
		}
		const lo = spawnAt - this.lockWindowMs;
		const hi = spawnAt + this.lockWindowMs;
		return names
			.filter((n) => n.endsWith(".jsonl"))
			.map((n) => {
				const ms = sessionStartMs(n);
				return ms != null && ms >= lo && ms <= hi ? path.join(sessionDir, n) : null;
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
