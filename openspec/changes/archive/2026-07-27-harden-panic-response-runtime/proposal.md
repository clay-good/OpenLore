# Harden the panic-response runtime: escapable blocking, atomic watcher singleton, honest gate

> Status: IMPLEMENTED (2026-07-18). Fixes four runtime defects in the opt-in behavioral
> governance subsystem WITHOUT changing its posture: modes stay off by default, blocking stays
> experimental and opt-in (the `defer-panic-blocking-enforcement` / `defer-panic-setup-hooks`
> decisions are untouched). The theme: an interventional feature must never trap the agent, race
> itself, or activate on an accuracy gate that is structurally unreachable.

## The gap

**(a) L4 blocking deadlocks its own recovery.** In `experimental_blocking` mode,
`panic-check.ts:85-89` emits `{decision:'block'}` for EVERY tool call once `panicLevel >= 4`, and
`HOOK_COOLDOWN_MS[4] = 0` (`panic-constants.ts:77-84`) means no cooldown thins it. The block
message tells the agent to call `orient()` — but the hook never reads the pending tool name from
the PreToolUse stdin payload (the action at `panic-check.ts:30` reads only CLI options), so the
prescribed `orient()` call is itself blocked. Result: a circuit-breaker with no escape except a
human editing config.

**(b) Watcher singleton races and PID recycling.** `gryph-watch.ts:61-67` enforces one-watcher-per
-directory with `existsSync` + `writeFileSync` — a TOCTOU window in which two concurrently launched
watchers both pass the check and both run. Conversely `isProcessAlive` (`gryph-watch.ts:42-45`,
`kill(pid, 0)`) treats a *recycled* PID as alive, wrongly suppressing a legitimate watcher forever.
The codebase already has the correct pattern: `withPanicStateLock` uses atomic `openSync(…, 'wx')`
plus an mtime staleness heuristic (`panic-response.ts:214-238`).

**(c) The accuracy gate is honest but inert — and quietly unreachable.**
`panic-validation.ts:41` types the verdict as `'INSUFFICIENT_DATA' | 'REVIEW_REQUIRED'` — CLEARED
does not exist (clearing is documented as a human call, `:1-13`), `:181` confirms nothing else is
emitted, and *nothing consumes the verdict*: `setup --panic advisory|experimental_blocking`
activates interventional modes with only a printed warning (`setup.ts:431-433`). Two subordinate
honesty gaps: the FP proxy counts resolved-by-decay as false positive (`panic-validation.ts:129-141`
— conservative and fine, but it must be presented as a proxy, not a true FP rate), and the gate
needs `MIN_EPISODES: 20` while `panic-validate` reads only the live `panic.jsonl`
(`panic-validate.ts:19`) and telemetry rotates at 5 files (`telemetry.ts:19-29`) — long-running
observation loses episodes and the gate can stay INSUFFICIENT_DATA forever.

**(d) Per-tool-call process cost when off.** The PreToolUse hook spawns a full Node process for
every tool call even in `off` mode — `panic-check.ts:39-42` exits early, but only after paying
startup + config read.

## What changes

- **(a) Recovery is always executable.** `panic-check` parses the PreToolUse stdin payload's tool
  name and exempts the prescribed recovery tools (orient and the read-only MCP no-ops) from the L4
  block; additionally a bounded auto-deescalation (derived from the existing decay constants, no
  new tuning constant) guarantees the block lifts even if the payload is unparseable. Blocking
  remains opt-in, advisory-flagged, exit-0 — posture unchanged.
- **(b) Atomic singleton.** The PID file is claimed with `openSync('wx')` (reusing the
  `withPanicStateLock` pattern) and carries a staleness heuristic disclosed in the file itself
  (e.g. process start time or heartbeat mtime), so a recycled PID no longer suppresses a legitimate
  watcher and two concurrent launches cannot both proceed.
- **(c) The verdict gains a consumer and a defined CLEARED emission.** The gate emits `CLEARED`
  when and only when all criteria (`PANIC_GATE`) are met — still never auto-acting; and
  `setup --panic advisory|experimental_blocking` consults the stored verdict: if not CLEARED it
  requires an explicit `--acknowledge-unvalidated`-style override to proceed (still sayable,
  never silently blocking — advisory doctrine intact). The FP proxy is labeled as a proxy
  (resolved-by-decay upper bound) in report and docs; `panic-validate` reads the rotated
  `panic.*.jsonl` files so the 20-episode floor is actually reachable.
- **(d) Off means cheap.** When mode is `off`, the hook is uninstalled (or a sentinel file lets
  the hook script exit before Node starts), so the per-tool-call cost is paid only by users who
  opted in. Measured before/after hook latency is reported in the PR (no unmeasured claims).

## Why this is in scope

The panic subsystem's whole license to exist is the honesty contract: advisory, opt-in, validated
before it intervenes. Today its blocking mode can trap the agent it supervises, its watcher
singleton is racy, and its validation gate is a road that ends in a wall (no CLEARED, no consumer,
telemetry rotation starves it). These fixes make the *documented* discipline true — no expansion of
Gryph, no default-on anything, no un-deferral of the deferred changes.

## Impact

- Files: `src/cli/commands/panic-check.ts`, `src/cli/commands/gryph-watch.ts`,
  `src/cli/commands/panic-validate.ts`, `src/cli/commands/setup.ts`,
  `src/core/services/mcp-handlers/panic-validation.ts`, `panic-response.ts` (shared atomic-claim
  helper), hook installer assets; tests for each.
- Specs: `cli` — 3 ADDED requirements (PanicBlockingNeverBlocksItsOwnRecovery,
  WatcherSingletonIsAtomic, InterventionalModeRequiresValidationAcknowledgement).
- Tool surface: unchanged (no MCP tool change, no payload-budget impact).
- Risk: (a) widens what an L4 block lets through — bounded to the named recovery tools;
  (c) adds one prompt/flag to an already-warned setup path; (b)/(d) are strict hardening.
