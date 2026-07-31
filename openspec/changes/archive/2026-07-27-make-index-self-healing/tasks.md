# Tasks — make-index-self-healing

> Status: IMPLEMENTED (2026-07-18, PR #225). Read-path staleness signals now trigger the
> generalized `repairInBackground` service (at-most-once, non-blocking, env + `autoInit:false`
> opt-outs) and served answers disclose the repair-in-progress marker; the watcher fires a
> debounced, coalesced graph rebuild on a `.git` HEAD change or budget-exceeded stale region
> (serve routes it through its coordinator, the in-process watcher self-spawns); and
> `openlore doctor --fix [--yes]` executes exactly the remediations the read-only checks print.

## Implementation
- [x] Generalize cold-start-bootstrap.ts into `repairInBackground(dir, reason)` — same
      at-most-once latch, never-block/never-throw, env + `autoInit:false` opt-outs; reasons:
      index-absent | integrity-mismatched | stale-region | schema-reset | analysis-age
- [x] Read-path trigger in mcp-handlers/utils.ts where `computeIndexIntegrity` and the
      stale-region/age checks already run: fire repairInBackground and thread
      "background refresh started" into the freshness note alongside the existing verdict
      (absent vs stale stay distinct) — mcp response note + `orient.indexRepair` +
      `ConfidenceBoundary.repair`
- [x] Watcher/daemon graph-rebuild trigger (mcp-watcher.ts, serve.ts): debounced background
      full analyze on stale-region-over-budget or `.git` HEAD change; post-commit hook path
      unchanged (opt-in via `onGraphStale`/`selfRebuild`, so the plain watcher is untouched)
- [x] Unify the schema-reset rebuild latch through the same service (the read-path schema-reset
      signal routes through `repairInBackground`; the watcher's own once-per-process self-heal
      remains as the fast path)
- [x] `openlore doctor --fix [--yes]`: execute the printed remediations (analyze, install
      --force re-wire); bare doctor stays read-only
- [x] Anti-thrash latch: a completed repair that still triggers discloses and stops

## Verification
- [x] Trigger tests: mismatched attestation / stale region over threshold / aged analysis
      each start exactly one background repair; opted-out repo never repairs; absent still
      routes through cold-start behavior unchanged
- [x] Disclosure tests: response during repair carries staleness verdict + refresh-started;
      never claims fresh; never blocks (latency bound)
- [x] Watcher tests: branch switch schedules one debounced rebuild; stale-region budget
      crossing schedules one; no rebuild storm under rapid HEAD flips
- [x] doctor --fix tests: fixes what it printed, nothing else; --yes non-interactive; bare
      doctor byte-identical to today (`--json` strips the internal remediation field)
- [x] Full suite green (290 files, 5654 passed); `openspec validate make-index-self-healing` passes
