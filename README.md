# Emergence-Pianist
An autonomous, self-learning agent built as thin Pi extensions — self-driving its sessions, studying its traces, compiling its drudgery away.

Emergence Pianist is the agent runtime for the [Pi coding agent](https://github.com/earendil-works/pi-coding-agent). It adds zero-intrusion self-learning to a stock Pi process: every capability ships as a thin extension layer, the session spine stays untouched.

## Architecture

Three layers:

```
┌─ shell (mms skeleton) ── approval queue · write queue · telemetry archive ─┐
│                                                                             │
│   stock Pi process ─── session spine (L0: bridging · distill · context)    │
│        │                                                                    │
│   extensions/ ── approval hook · memory injection · ledger bridge          │
│                 telemetry (self-learning interface) · bridge tool          │
└─────────────────────────────────────────────────────────────────────────────┘
```

- The Pi process is version-locked and never patched. All features are extensions; Pi upgrades never break the house.
- The shell never calls an LLM API itself.
- Self-learning is a removable sidecar: unplug it (env switch) and conversations continue unchanged.

## Self-learning discovery loop

The second loop asks: *should this step still be done by a reasoning agent at all?*

```
telemetry hooks ─▶ JSONL archive (v1) ─▶ hotspot scanner ─▶ retropad verdict ─▶ draft candidates
   (per tool call,          (per agent,     (repetition ×        (the only            (human
   usage, session)           per day)        convergence,          judgment             review
                                            all mechanical)       dimension)            decides)
```

- **Repetition & convergence are mechanical** — measured by the scanner, never by an LLM.
- **Cognitive waste is the one judged dimension** — a spawned reviewer agent ("retropad") sees only preprocessed hotspots (fingerprints + evidence pointers), and "nothing worth recording" is the expected majority output.
- Candidates are born as drafts in a capability library — the nursery is not the registry.
- **Teardown-tested**: with all self-learning components unplugged, a normal session and a cold-start injection run identically (verified 2026-09-21).
- **Dismantled state is silent by design**: when the shell is absent (`PIANIST_SHELL_URL` unset), the telemetry hook drops events without logging — the removed organ doesn't cry pain, and the pain channel is part of the removed set. When the shell **is** present and ingest fails, every dropped batch is warned and counted, with a session-boundary summary (losing data must be loud, even though losing it never interrupts the session).

## Quick start

```bash
git clone <this repo> && cd Emergence-Pianist
npm install

export ZAI_CODING_CN_API_KEY=<your key>   # required — the repo carries no keys
bash start-pianist.sh                     # brings up shell + local services, then an interactive Pi session
```

Environment knobs (all optional): `PIANIST_SHELL_URL`, `PIANIST_AGENT_ID`, `PIANIST_TELEMETRY=off` (zero-overhead switch), `PIANIST_TELEMETRY_DIR`, `PIANIST_SHELL_PORT`. External service paths (`GRIMOIRE_DIR`, `STIGMERGY_ROOT`, `SPOOR_SRC`, `SPOOR_PYTHON`) default to `$HOME/...` and can be overridden.

## Tests

```bash
npm test          # 12 suites, deterministic, no API key needed (sandbox-shell suite needs a local docker daemon)
npm run test:live # real-model end-to-end (spends tokens, manual)
```

## Sandbox

Sandboxed execution, first cut (施工⑤): `src/sandbox.mjs` ships `SandboxManager` — an 8-method, SWE-ReX-shaped contract (sessions / one-shot `execute` / files / lifecycle) over a hardened container engine: one session = one docker container (`--cap-drop ALL`, `no-new-privileges`, non-root with host-uid alignment, 512m / 1 cpu / 256 pids caps, zero port publishing, `pianist-sandbox=1` owner label, `docker rm -f` on close). Contract souls: errors cross boundaries with their class path (`__type`) and revive into real types; `X-Request-ID` makes retries idempotent; sessions live in the manager process, so a dropped connection never kills a running command.

Scope of this cut: container engine + shell wiring (施工⑤ second cut) — `sandbox_*` actions route through the same `/tools/invoke` entrance into a lazy shell-level `SandboxManager` singleton (zero overhead until first use), under the existing three-tier approval sight: `rm -rf` / escape attempts / cloud-metadata probes (169.254.169.254) still gate on human approval; container-side downloads (`npm install`, `curl`) stay amber as normal workflow. Errors cross the HTTP boundary with their class path (`errorDetail.__type`) for client-side revival; `X-Request-ID` idempotency is carried by the manager's internal request cache. `microvm` remains a reserved discriminated-union slot that throws "not implemented in this iteration". Zero-credential rule: nothing from the host environment (keys included) is ever injected into a sandbox — credentials live only on the host. Tests: engine face via `node --test test/sandbox-engine-test.mjs`; shell wiring via `test/sandbox-shell-test.mjs` (part of `npm test`). Both need a local docker daemon.

## Conductor (resident)

The conductor runs as a systemd service (`Restart=on-failure`, budget gate as backstop; keys live only in `/etc/pianist/conductor.env`, mode 600, outside the repo). The shell ships as a canonical unit too — both are installed by the same script, which also tears down same-source alien units (disable-only) and swaps any transient shell into the canonical unit:

```bash
CONDUCTOR_NODE_BIN=NODE_BIN bash deploy/install-conductor.sh   # installs conductor + shell units (idempotent; --dry-run previews; self-preserves when run from inside the conductor's own cgroup)
node src/conductor.mjs --self-check                                          # rehearsal face of the startup canonicality gate (alien/disabled units exit loudly at boot)
systemctl disable --now pianist-conductor && rm /etc/systemd/system/pianist-conductor.service /etc/pianist/conductor.env && systemctl daemon-reload  # uninstall
systemctl is-active pianist-conductor pianist-shell && node src/conductor.mjs --status  # check status (is-active + today's spend/draws as JSON)
```

Rearm scavenger (canonical, `deploy/rearm-conductor.sh`): when the installer defers a restart because it lives inside the conductor's own cgroup, hang this via `systemd-run --collect` instead of hand-rolling a /tmp script. Its liveness probe reads `cgroup.procs` against `MainPID` — pi rewrites its argv to `pi`, so any `pgrep -f cli.js` probe is structurally blind (2026-09-29: such a blind scavenger killed a wander mid-report 20s after being hung). Read failures count as busy: it can only fire late, never early.

Board-face cooldown for spoor-session (2026-09-30): when a spawned spoor-session retires cleanly (`exit=0`), the conductor records a sha256 fingerprint of the exact board it judged on the launch record (`faceHash`). While the board is byte-identical and within the cooldown window (`CONDUCTOR_SPOOR_FACE_COOLDOWN_H`, default 12h), the part is excluded from draws — an unchanged board re-judged is an empty-card confirmation run, same disease family as the env-event backoff. Any byte of board change, cooldown expiry, or a non-zero exit restores eligibility immediately (verdicts are time-sensitive: deadlines walk, upstream packages arrive). Reinstall-seam discipline is generalized in `deploy/install-conductor.sh`: every existing `CONDUCTOR_*` line in `/etc/pianist/conductor.env` survives a rewrite (current env > file line), so no seam evaporates on reinstall.

Board-face mechanical migration (T8, 2026-10-02): the read side of the board pipeline (`fetchTodoBoard`) no longer drops old-format lines into a malformed "格式非法" bucket — the 10/01 incident had a confirmed `T6(新)` entry silently swallowed because its decorated ID didn't match the v0.9 shape. Three archaeologically confirmed legacy shapes are now virtually migrated to the v0.9 shape in pipeline memory only — STATUS.md is never written back (real migration write-back is a living human's job; the pipeline doesn't cross that line): ① decorated IDs like `T6(新) [the author]…` are stripped to the bare number, appending an apostrophe on collision with an existing segment ID (`T6'`) — mechanical migration never mints duplicate IDs; ② ID-less bullets (the pre-9/26 circled-number style, e.g. `⑤第二铲：…`) get mechanical numbers, max(existing segment `T<n>`, 100)+1 — numbers ≤100 are reserved for hand-written IDs, so a number-less segment starts at T101; ③ inline prose lines (tideline 9/24 shape) are never converted — converting prose fabricates structure — and are listed separately as 非条目（散文段）. Migration shapes, never invents content: missing 归属/出处/判据 fields stay empty and surface honestly as 缺X skips for requeue. Migrated rows carry （迁移 T<n>）（迁移改名） markers on both board paths (textual lines + structured boards); the convergence line's 格式非法 bucket is replaced by 迁移 X·散文 Y.

Hotspot heartbeat (2026-10-01 wander, claiming the 09-30 seed "the discovery loop has no heartbeat"): `latest.json` used to refresh only when someone remembered to run the scanner — it stalled for five days while three same-board spoor reruns went unseen. The conductor now heartbeats the loop itself: at the top of every tick, before every early return (budget hard-stop, busy, pool-cooled — the heartbeat is not a draw-account entry, purely mechanical, zero LLM, never counts toward `draws`/`launches`/budget), it rescans when the report is staler than `CONDUCTOR_HOTSPOT_STALE_H` (default 20h; acceptance shape: the report never goes 25h+ stale). Success/failure both land in state (`last_hotspot_scan`, surfaced by `--status`); a failed scan arms a 5-minute retry cooldown (alarm preserved, no journal spam, self-healing overwrite). Deliberately not a third systemd unit+timer pair: deployment seams are this house's top recurring wound, the conductor is already resident with a pinned node and the canonical rearm — the heartbeat rides it, and a dead conductor means a dark house with no fresh telemetry to scan anyway. Knobs: `CONDUCTOR_HOTSPOT_STALE_H`, `CONDUCTOR_HOTSPOT_OUT`, `CONDUCTOR_HOTSPOT_DIR` (defaults follow `PIANIST_TELEMETRY_DIR`).

## Status

Discovery loop shipped (telemetry → scanner → retropad → drafts) and teardown-tested. The candidate lifecycle (shadow / promote / reject, due budgets, exam fields) is not built yet — this repo tracks the first half of the loop only.

Conductor part pool: wander / env-event / todo-review / spoor-session. spoor-session promoted 2026-09-25 (§8 second cut): the conductor pre-fetches the workbench "next steps" board and machine-checks the three-piece admission (provenance / acceptance criteria / due budget) per todo; the spawned session then rules on which qualified todos are worth acting on now (consensus-claim notify duty, budget-death rulings, first-round full roster for retroactive approval — notify-ring delivery lands in the next cut).

## License

TBD
