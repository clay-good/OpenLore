# Tasks — contain worker faults, bound per-file cost, disclose every skip

## Reproducers (write these first — they are the acceptance criteria)
- [ ] Minimal abort reproducer as an integration fixture: one 300 KB file of repeated `/*x` plus
      ~600 trivial `.ts` files; asserts exit 0 and artifacts present (today: exit 134,
      `libc++abi: terminating due to uncaught exception of type Napi::Error`)
- [ ] Budget reproducer: the same 300 KB file alone; asserts the run completes and the file is
      recorded `budget-exceeded` (today: ~661 s, exit 0, no record)
- [ ] Control: a large-but-ordinary generated file must NOT be recorded as `budget-exceeded`, and the
      graph must match a run with the budget disabled — a bound that silently drops real files is the
      failure mode this change is supposed to prevent

## Implementation
- [ ] Extraction pool: install per-worker boundaries for the faults a plain `try`/`catch` cannot see
      (`uncaughtException`, `unhandledRejection`, worker `error`, non-zero `exit`) and map each to a
      structured per-file extraction failure
- [ ] Extraction pool: a fault degrades ONE file and the run continues; a pool that cannot continue
      surfaces a JS-level error through the CLI error path (never `abort()`)
- [ ] Per-file wall-clock budget as a named constant, operator-overridable; abandon + record
      `budget-exceeded` with elapsed time
- [ ] Extend the parse-health record with the new reasons (`worker-fault`, `budget-exceeded`,
      `size-cap`, `encoding`) so every exclusion has a machine-readable cause
- [ ] `analyze` summary: replace the bare `Files skipped: N` with a per-reason breakdown
- [ ] `doctor` extraction-health check reads the same record — no independent judgment, so the two
      surfaces cannot contradict each other
- [ ] Progress output names a file whose extraction exceeds a disclosure threshold; to stderr, so
      `--json` stdout stays clean
- [ ] Conclusion tools: a result touching a `budget-exceeded` or `worker-fault` file carries the
      existing parse-health boundary disclosure (reuse `parse-health-boundary.ts`; no new mechanism)

## Verification
- [ ] Both reproducers fail on `origin/main` and pass after the change (the abort is verified
      pre-existing — the fix must be demonstrated, not assumed)
- [ ] `analyze` output on a clean repository is byte-identical to before (no new noise, no new
      artifact when nothing was excluded)
- [ ] Differential: analysis artifacts unchanged on a real repository, with timestamps normalized

## Deliberately NOT in this change
- [ ] Making the 661 s parse fast. That cost is in the grammar/extractor layer and needs its own
      investigation; this change makes it bounded, attributable and disclosed. The budget record is
      what makes the follow-up measurable.
- [ ] Nothing borrowed from another tool: the worker-boundary and per-file-budget shapes are ordinary
      Node worker hygiene, not a competitor's design.
