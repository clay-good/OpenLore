# Tasks — harden-panic-response-runtime

## Implementation
- [x] `panic-check`: parse the PreToolUse stdin payload's tool name; exempt orient + read-only
      recovery tools from the L4 `experimental_blocking` block
- [x] `panic-check`: bounded auto-deescalation fallback (derived from existing decay constants,
      no new tuning constant) so an unparseable payload cannot leave a permanent block
- [x] `gryph-watch`: replace existsSync+writeFileSync PID claim with atomic `openSync('wx')`
      (`claimWatcherSingleton`, same create-exclusive pattern as `withPanicStateLock`) + a staleness
      heuristic (heartbeat = PID-file mtime, refreshed every `WATCHER_HEARTBEAT_MS`)
- [x] `panic-validation`: define the `CLEARED` verdict, emitted only when all `PANIC_GATE`
      criteria are met; label the FP proxy as a resolved-by-decay upper bound, not a true FP rate
- [x] `panic-validate`: read rotated `panic.*.jsonl` files (`readPanicTelemetry`, spanning
      `MAX_ROTATED_FILES` archives), not just the live file, so `MIN_EPISODES` is reachable
- [x] `setup --panic advisory|experimental_blocking`: consult the stored verdict; when not
      CLEARED require an explicit `--acknowledge-unvalidated` override (disclosed, never silent)
- [x] Off-mode cost: a fail-safe sentinel (`.openlore/panic-check-disabled`, written by
      `setup --panic off|observe`) lets the guarded PreToolUse command skip spawning Node entirely.
      Absence of the sentinel means "run" (existing installs unaffected).

## Verification
- [x] Test: at L4 in experimental_blocking, an orient PreToolUse payload is NOT blocked; an
      arbitrary tool IS; an unparseable payload deescalates within the bounded window
      (`panic-response.test.ts`: deescalatePanicByWallClock + parsePendingToolName + isRecoveryTool)
- [x] Test: two concurrent gryph-watch launches → exactly one survives; a recycled/stale PID does
      not suppress a new watcher (`gryph-watch.test.ts`)
- [x] Test: gate emits CLEARED only when all criteria met; setup refuses interventional mode
      without CLEARED unless `--acknowledge-unvalidated` is passed (`panic-validation.test.ts`,
      `setup-hooks.test.ts` evaluatePanicActivation)
- [x] Test: validator counts episodes across rotated telemetry files (`panic-validation.test.ts`
      readPanicTelemetry)
- [x] Measured off-mode PreToolUse hook latency: ~200 ms/call (full Node spawn) → ~0 ms (shell
      `test -f` short-circuit, no spawn) when the disabled sentinel is present.
- [x] Full suite green; `defer-*` panic decisions untouched (posture unchanged — modes stay off by
      default, blocking stays opt-in and advisory-flagged)

## Spec
- [x] `cli` delta: ADD PanicBlockingNeverBlocksItsOwnRecovery, WatcherSingletonIsAtomic,
      InterventionalModeRequiresValidationAcknowledgement
