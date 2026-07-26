# Tasks — contain worker faults, bound per-file cost, disclose every skip

> Status: **BUILT** (2026-07-26). Measured on the 601-file reproducer: **exit 134 → exit 0**, and
> **217 s → 44 s**. Full suite (6,458 tests), lint, typecheck and build pass.

## Reproducers (written first — they are the acceptance criteria)
- [x] Minimal abort reproducer: one 300 KB file of repeated `/*x` plus ~600 trivial `.ts` files.
      Isolated the cause exactly — the payload parses for **84 s** and yields a **100,002-deep**
      tree, and the recursive parse-health walk overflowed on it. A `RangeError` raised inside the
      native binding's node accessor is not catchable as a JS throw, which is how it surfaced as
      `libc++abi: terminating due to uncaught exception of type Napi::Error`, exit 134
- [x] Budget reproducer: the same file is abandoned at the budget and recorded `budget-exceeded`
- [x] Control: an ordinary 1.4 MB generated file is NOT recorded, and its graph is byte-identical to
      a run with the budget disabled. Differential over the whole 706-file repository: byte-identical

## Implementation
- [x] `parse-budget.ts`: the bound, in-band via tree-sitter's own deadline — the only bound that can
      interrupt a synchronous native parse. `PER_FILE_PARSE_BUDGET_MS` (20 s), overridable with
      `OPENLORE_PARSE_BUDGET_MS`; `0` restores the previous behaviour exactly
- [x] Applied at **every** tree-sitter parse site: 9 per-language extractors, the generic native and
      WASM grammar handles, 23 synthesis-pass re-parses, plus the three serve-time parses
      (chunker, exception flow, error propagation) that would otherwise wedge the daemon
- [x] The parse-health walk is iterative — depth stops being a correctness cliff, which is what
      removes the abort's cause rather than racing it
- [x] Extraction pool + worker: `uncaughtException` / `unhandledRejection` boundaries inside the
      worker, attributed to the in-flight file; non-zero worker exit named in the failure
- [x] A worker fault routes the file to the main thread regardless of proven language
- [x] Parse-health record carries a machine-readable `exclusion` and a per-reason rollup
- [x] `analyze` reports skipped files by reason, and excluded files with their cause
- [x] `doctor` reads the same record through the same helper — the two cannot disagree
- [x] Slow-file attribution: live on the pooled lane (to **stderr**, because `logger`'s non-error
      levels go to stdout and the same build runs inside the stdio MCP server), and named on the
      lane disclosure for both lanes
- [x] Conclusion tools disclose an excluded file through the existing parse-health boundary

## Verification
- [x] Both reproducers fail on `origin/main` and pass after the change
- [x] Real repository unchanged: 997 files, 3,148 functions, 18,022 edges, 18.6 s, no new output
- [x] Differential: serialized call graph byte-identical with the budget on vs. off
- [x] `parse-health.json` byte-identical across two runs of the reproducer repository

## Deviations from the proposal (measured, not assumed)
- [x] **`worker-fault` is not a file-level exclusion reason.** The proposal listed one. A worker
      fault no longer excludes a file at all: the pool hands it to the main thread, so the facts
      stay whole and the fault is disclosed on the lane. Recording it against the file would blame
      the source for a defect in the thread reading it
- [x] **The record stores the budget, not the measured elapsed time.** `parse-health.json` is
      persisted and must be byte-identical across re-analyses (change:
      fix-artifact-output-determinism); a wall-clock number would break that on every repository
      with such a file. Nothing is lost — a file is only recorded because it ran past the bound.
      The measured time still reaches the operator live, on the (unpersisted) lane disclosure
- [x] **`encoding` is not an exclusion either** — a lossy decode does not exclude a file, so it
      stays the separate `encodingFallback` signal it has always been
- [x] **`analyze --json` does not exist**; the CLI requirement is stated against the real
      machine-output surface for this code path, the stdio MCP server

## Defects this change's own controls caught (each has a regression test)
- [x] A timed-out tree-sitter parse is SUSPENDED, not discarded — the next file resumed it and
      silently produced zero symbols. The parser is now reset at the deadline
- [x] `web-tree-sitter@0.25` exposes `setTimeoutMicros` and throws from inside it, which failed
      every Dart and Lua file. Arming is now fail-soft and the refusal is remembered per parser
- [x] The budget was being spent once per PASS, not once per file (92 s for one 20 s bound).
      Abandoned files are dropped from the later re-reading passes
- [x] A boundary rendered `undefined` for an exclusion reason written by a newer build

## Deliberately NOT in this change
- [x] Making the 84 s parse fast. That cost is in the grammar/extractor layer and needs its own
      investigation; this change makes it bounded, attributable and disclosed. The budget record is
      what makes the follow-up measurable
- [x] Memoizing an abandoned file. The Pass-1 memo deliberately never caches a throw, so such a
      file re-pays its budget each run — disclosed by the existing "will re-extract each run" note
- [x] Nothing borrowed from another tool: the worker-boundary and per-file-budget shapes are
      ordinary Node worker hygiene, not a competitor's design
