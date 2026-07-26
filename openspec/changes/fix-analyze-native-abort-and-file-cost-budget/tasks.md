# Tasks — contain worker faults, bound per-file cost, disclose every skip

> Status: **BUILT** (2026-07-26). Measured on the 601-file reproducer: **exit 134 → exit 0**, and
> **217 s → 52 s**. Full suite (6,480 tests), lint, typecheck and build pass.
>
> Hardened after four independent adversarial reviews found eight confirmed defects in the first
> revision — see "Defects adversarial review found" below. Every fix is mutation-checked.

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

## Defects adversarial review found in the FIRST revision (each now has a mutation-checked test)
- [x] **The cost optimization silently deleted call edges in healthy files.** Dropping
      budget-exceeded files from `buildResolvedImportMap` removed re-export information belonging
      to files that parsed cleanly — `parseJSExports` is a REGEX scan and reads an abandoned file
      perfectly well. Reproduced by two reviewers independently. The filter no longer applies to
      that pass; it stays only on the passes that genuinely re-parse (where the file would
      contribute the same nothing anyway). Correctness over the seconds it saved
- [x] **The budget was charged twice on the pooled lane.** A budget overrun for a language the
      worker had not yet proven fell through to the main-thread recheck, spending a second full
      bound. A budget overrun is a property of the FILE, so it is trusted
- [x] **A faulting worker stole a file from a healthy sibling.** The fault path used `continue`;
      the worker's boundary closes its channel immediately after answering, so every later request
      to it was a silent no-op. Now `break`, matching every other worker-death path. The stub lane
      was also unfaithful here (it kept answering after "faulting") and now models the close
- [x] **`slowFiles` double-counted** a file timed on both lanes, evicting genuinely distinct slow
      files from the cap. Deduped, worst time kept
- [x] **The WASM demotion never fired.** `deadlineUnsupported` was keyed on the parser INSTANCE,
      and the WASM lane builds a fresh parser per file — so the throw was re-paid on every file,
      exactly what the comment claimed it avoided. Keyed on the constructor now (not the prototype:
      every object literal shares `Object.prototype`, which would demote unrelated parsers)
- [x] **A budget overrun in a LATER pass was swallowed with no record.** A file that squeaks under
      the bound in Pass 1 and overruns in the class-relationships pass now carries an exclusion
- [x] **The watcher erased a `size-cap` exclusion**, so `doctor` reverted to a clean bill of health
      after a touch. It applies the same bound instead of assuming the file became healthy
- [x] **Excluded files were counted as "parsed with errors"** — a never-parsed file, with a remedy
      pointing at tree-sitter grammars. Counted and worded separately now
- [x] **Nine surviving mutations closed**, including: `reparsableFiles` was entirely untested; the
      `sanitizeForTerminal` call on the stderr path was untested (this repo has a terminal-escape
      history); the "worker faults, graph stays whole" test induced no fault and was a weaker
      duplicate; the source-order test covered only the branch production never takes; the
      analyze/doctor agreement tests were source greps that passed with both surfaces rendering
      nothing; and the `size-cap` producer had no test at all

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
