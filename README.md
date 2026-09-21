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
npm test          # 5 suites, deterministic, no API key needed
npm run test:live # real-model end-to-end (spends tokens, manual)
```

## Status

Discovery loop shipped (telemetry → scanner → retropad → drafts) and teardown-tested. The candidate lifecycle (shadow / promote / reject, due budgets, exam fields) is not built yet — this repo tracks the first half of the loop only.

## License

TBD
