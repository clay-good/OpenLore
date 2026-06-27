# Tasks — Adopt the agent behavioral governance layer (staged)

> Rebase PR #83 onto current `main`. Land the core green; defer the heavy machinery. Call
> `record_decision` before the `panicResponse.mode` config contract and the
> `updatePanic()`/`updateTracker()` split (both architectural), per `CLAUDE.md`.

## 1. Integration onto current main (this PR — get to green)
- [x] Port net-new files: `panic-response.ts`, `panic-constants.ts`, `panic-check.ts`, `panic-level.ts`
      and their tests.
- [x] Add behavioral fields to `EpistemicTracker`; extract `updatePanic()` from `updateTracker()` and
      export it. `updateTracker()` (V4 freshness, `repoMovedSinceOrient`) stays unchanged and always runs.
- [x] Resolve `mcp.ts`: panic injection rides the **current** response path (`rawText` → `capOutput`),
      and `panic_level`/`panic_score` are added to main's richer `tool_call` emit (not a duplicate emit).
- [x] Resolve `telemetry.ts`: combine `redactSecrets()` (main, security) **with** rotation (PR). Redaction
      remains on every write.
- [x] Resolve `setup.ts`: DEFERRED the whole `setup` wiring (`--panic` **and** `--hooks`) to the hooks
      follow-up — setup.ts stays exactly as main (zero conflict / zero risk). This also sidesteps the
      `installClaudeHook` break (we never import it). Users opt in via `panicResponse.mode` in config.
- [x] Resolve `index.ts` (union command registration), `config-manager.ts`, `types/index.ts`.
- [x] `panicResponse.mode` added to `OpenLoreConfig`; ladder = `off | observe | advisory`; default `off`.
- [x] Reverted the PR's localityConfidence gate on **freshness** depth-escalation — `updateTracker()`
      semantics now identical to pre-panic main (panic:off is a zero-behavior-change path).
- [x] `tsc` clean; lint clean; full suite green (4240 passed, 2 skipped).

## 2. Safe defaults (this PR)
- [x] `mode: 'off'` default → zero panic overhead (`updatePanic()`/`writePanicState()` gated on
      `panicPolicy !== 'off'`; injection only at `advisory`).
- [x] `panic-check` and `panic-level` always exit 0 (fail-open) on every code path.
- [x] No hook auto-installed by `setup` (setup wiring deferred).
- [x] `updateTracker()` runs in all modes; only `updatePanic()` + `writePanicState()` are gated on mode.

## 3. Telemetry panic section (this PR)
- [x] `panic.jsonl` domain events with provenance (`panic_score_delta`, `panic_level_change`).
- [x] `openlore telemetry` panic summary (episodes, recovery latency, trigger frequency).
- [x] **Observe-mode validation readout** (`computePanicValidation`) — the deterministic measurement
      substrate for the accuracy gate: false-positive proxy (episodes resolved without re-orient),
      intervention follow-through (`panic_intervention_outcome` per intercept), and a gate verdict that
      is `INSUFFICIENT_DATA` / `REVIEW_REQUIRED` and **never auto-`CLEARED`** (clearing is a human call).
      This ships the *tooling to measure*; actually running observe-mode, gathering episodes, and
      deciding remains the follow-up (§5).

## 4. Decisions + spec sync (this PR)
- [ ] `record_decision`: adopt behavioral governance as an extension of the EpistemicLease nudge surface;
      core lands behind `mode:'off'`, intervention + Gryph + hooks deferred.
- [ ] `record_decision`: `panicResponse.mode` config contract; `updatePanic()`/`updateTracker()` split.
- [x] No new tool enters the default/minimal MCP surface (panic-check/panic-level are CLI commands, not
      MCP tools; no MCP tool added).

## 5. Full feature built in this PR (was deferred; now opt-in + off by default)
- [x] **Expanded observe-mode validation gate** — `openlore panic-validate` (+ `--json`):
      per-trigger false-positive attribution, peak-level histogram, intervention follow-through,
      pass/fail criteria, actionable recommendations; verdict `INSUFFICIENT_DATA`/`REVIEW_REQUIRED`,
      never auto-`CLEARED`. Also fixed the `call_triggers` bug (telemetry "triggers" was always empty).
- [x] **`experimental_blocking`** — back on the ladder as an EXPLICIT opt-in (never default); L4 emits
      `{decision:block, advisory:true}`. Below L4 == advisory.
- [x] **Gryph** (`gryph-bridge.ts`, `gryph-watch.ts`, CAS) — re-attached fail-open (no-op when the
      `gryph` binary is absent); `gryph-watch` exits silently on `off`. CAS/`gryphWindowStart`/`GRYPH_*`
      plumbing now live.
- [x] **`setup --hooks` / `--panic`** — opt-in installers; never installed by a default `setup`;
      reconciled with `--global`; no `installClaudeHook` dependency; interventional modes warn to validate.
- [x] **observe → memory feedback loop (end-to-end)** — `openlore panic-hotspots` (+ `--write`)
      persists `behavioral-hotspots.json`; `orient()` consumes it and surfaces a contextual
      `behavioralHotspots` block (fail-open, gated on mode != off, labeled-only, omitted in lean mode).
- [x] **`panic-validate --strict`** — opt-in non-zero exit for CI/automation (gate as an actual gate).

## 6. Accuracy validation — the in-code half (built)
- [x] **Deterministic replay** — injectable engine clock (behavior-preserving; full suite confirms)
      + `replayBehavioralTrace()` drives the real engine over a `(tool, filePath, gapMs)` trace.
      `openlore panic-replay <trace.jsonl>` replays a recorded/synthetic session → panic timeline.
- [x] **Labeled-corpus calibration** — `computeCalibration()` measures false-positive rate + sensitivity
      at the L2 threshold against a ground-truth corpus (coherent vs confused). `openlore panic-calibrate
      [--json] [--strict]`. CI asserts 0% FP, 100% sensitivity on the clear-cut corpus.
- [x] **Honest sensitivity disclosure** — the harness FOUND a real over-sensitivity
      (`occasional-cross-check`: dwell-insensitive oscillation trips on long-dwell work with periodic
      checks). Documented + regression-pinned, NOT silently changed (that's signal-design for the
      author). This is the evidence the gate must weigh.

## 7. Still gated / remaining (operations + data, not code)
- [ ] **Clear the gate on real data.** The machinery and the in-code accuracy harness are built; what
      remains is **not a code stub**: run `observe` mode on real sessions, then confirm with
      `openlore panic-validate` (use `--strict`) that (a) the false-positive rate is low (focused deep
      work doesn't trip L2+), (b) `panic_intervention_outcome` trends positive, (c) episodes resolve.
      Only then may a maintainer enable an interventional posture by default — a human decision.
- [ ] **(Optional follow-up) Dwell-aware oscillation.** The calibration documents a fix candidate for
      the over-sensitivity; the calibration harness now exists to validate any such change safely.

## 8. Adversarial hardening (deep multi-agent red-team rounds)

Findings from manual + parallel-agent adversarial testing, all fixed + regression-tested in #175:

- [x] **mode:'off' telemetry leak** — resetTracker() emitted panic_orient_reset on the always-run
      freshness path; extracted resetPanicOnOrient(), gated on mode.
- [x] **Cross-writer revision regression** — fresh MCP session clobbered the hook's revision; seed
      from max(tracker, disk).
- [x] **orient garbage hotspot** — readHotspotArtifact now shape-validates each entry; **panic-replay**
      malformed-filePath crash sanitized.
- [x] **Decay starvation (high)** — per-call floor + baseline reset discarded the sub-12s remainder, so
      active agents never decayed (pinned at CRITICAL). Now remainder-preserving — decay accrues by
      wall-clock regardless of call cadence.
- [x] **Fail-open exit codes** — panic-check/panic-level exited 1 on commander parse errors (before the
      action try/catch); allowUnknownOption + exitOverride(→0).
- [x] **Cross-process state races (high)** — panic-check increment lost updates + casWritePanicState
      read→rename window let concurrent CAS writes clobber. Real O_CREAT|O_EXCL cross-process lock
      (recordHookInterventionLocked + locked CAS) + unique temp names. Verified: 40 concurrent → 40
      increments; 1187 CAS successes → revision 1187.
- [x] **Gryph orphan processes (high)** — forking-gryph grandchildren orphaned on each daemon timeout;
      async path now spawns detached + SIGKILLs the group.
- [x] **Gryph env NaN crash (med-high)** — non-numeric OPENLORE_GRYPH_POLL_INTERVAL_MS crashed
      gryph-watch + left a stale PID; NaN-safe coercion + startup try/catch cleanup.
- [x] **setup clobbered corrupt settings.json** — now refuses to overwrite an existing unparseable file.

Verified ROBUST under adversarial load (no change needed): mode:'off' zero panic behavior end-to-end;
secret confinement (no API keys/tokens leak to telemetry/state); MCP tool surface unchanged (60);
freshness signal unchanged by panic mode; atomic state-file rename (never corrupt); daemon
SIGTERM/SIGINT/stdin-EOF lifecycle + PID singleton; score bounds [0,100]; hysteresis/ceiling/refractory
boundaries; determinism; ~50k-step replay performance.

## 9. Final adversarial round (deep multi-agent: lock-stress, replay, resource, property, multi-agent)

- [x] **withPanicStateLock let fn() throw out** — write failures inside the lock escaped (fail-open
      violation). Wrapped fn() → returns fallback. Plus `atomicWriteState()` unlinks the temp on any
      failure (no `.tmp` leak in a long-lived daemon). LOCK_STALE_MS 5000→1500 + a short daemon attempt
      budget (no event-loop stall on the gryph poll path).
- [x] **panic-hotspots --write silent failure** — now prints the report first, writes in its own
      try/catch with a stderr warning.
- [x] **null trigger** from a name-less `panic_score_delta` — string-name guard in validatePanicSignal.
- [x] **gryph-watch premature exit on closed-pipe stdin** — the stdin-EOF parent-death proxy was unsound
      (the `UserPromptSubmit &` launch closes stdin); removed it. Daemon now runs until SIGTERM/SIGINT/
      SIGHUP or until panic mode is set off in config (a real stop control + orphan bound); cleanup is
      idempotent; SIGHUP no longer leaks the PID.
- [x] **Advisory injection floor aligned to L2** — `getPanicSignalText` injected at L1, contradicting the
      README (`advisory … L2+`) and the calibration ("L2 is the advisory-injection floor"). Now gated at
      `PANIC_INJECTION_MIN_LEVEL = 2`; L1 is observe-only (tracked, not intervened on).

Verified ROBUST (no change needed): the cross-process lock is lossless under sustained multi-agent load
(3 concurrent MCP servers + gryph-watch + hooks, ~1.1M reads, revision monotonic to 854, 0 corruption,
0 lost cooldowns, 0 crashes); lock serialization at 50–100 writers loses 0 writes; stale-lock steal
correct; no fd/SharedArrayBuffer leak (40k calls → fds flat); symlinked state path safe; double-signal
cleanup safe. **Property-based: all hard invariants held across 137,552 random steps** (score∈[0,100],
level∈{0..4}, density/oscillation∈[0,1], freshness monotonic, post-orient reset, determinism, no throws).

Documented-not-a-bug: a stale tracker hit by a heavy architectural tool jumps `staleDepth` 1→3 in one
step (intentional pre-panic freshness burst), so the panic CEILING floors the level 0→2 in that step.
The "≤1 level per step" smoothing applies to score-based transitions, not the ceiling — the ceiling is a
deliberate immediate floor (`staleDepth≥3 → ≥L2`). Left unchanged (freshness semantics are out of scope).
The MCP hot path writes panic-state with the unlocked `writePanicState` by design — locking a
request-serving event loop would be worse than the (self-healing via `max(tracker,disk)`) revision race,
which did not reproduce under real load.
