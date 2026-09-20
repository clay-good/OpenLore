# A deterministic counter-based performance budget in CI — catch the "fourth parse pass" before it lands

> Status: PROPOSED (2026-07-03, e2e audit pass 4, enhancement). CI runs only `npm run test:run`
> (`.github/workflows/ci.yml:53`); there is no performance-regression guard anywhere. Nothing
> would catch a one-line regression that reintroduces a full node-table load per changed file, a
> fourth corpus parse pass, or an eleventh per-call adjacency rebuild — exactly the defects the
> scale-track fixes in this audit remove. The only perf-adjacent artifacts are wall-clock ReDoS
> budgets (flaky by construction) and byte-budget payload tests. Prior art (rustc-perf, SQLite's
> speed tests, iai-callgrind) settled the answer years ago: **count deterministic work units,
> never wall-clock.** Instruction-count harnesses aren't practical for Node/TS, but the
> *principle* maps directly onto counters OpenLore already controls.

## The gap

- No CI step measures analyze/serve cost. `bounded-computation.test.ts:22-28` asserts 2s
  wall-clock ReDoS budgets — security-scoped and flaky. `mcp-presets.test.ts` asserts
  tools/list byte budgets (the "budget bit again" churn the memory notes repeatedly). `src/bench/`
  measures agent-transcript metrics, not engine performance.
- The scale fixes in this audit (`optimize-analyze-pipeline-passes`,
  `optimize-incremental-and-coldstart-scale`, `optimize-serving-hot-path-caches`) each remove a
  redundant O(repo) cost. Without a guard, the next refactor silently reintroduces one and no
  test fails.

## What changes

1. **A test-only work-counter hook.** Instrument countable, deterministic work units behind a
   flag the harness reads: files parsed, tree-sitter `Query` constructions, full node-table
   loads (`getAllInternalNodes`), `buildAdjacency` invocations, per-caller type inferences, SQL
   statements prepared, artifact bytes written. Counters increment in normal code paths only when
   the hook is active (zero overhead otherwise).
2. **Budget assertions on a pinned fixture repo.** Plain `.test.ts` (CI-visible, per the
   `test/`-is-gitignored constraint) asserts exact budgets on a fixed fixture: "analyze parses
   ≤N files (== the graphed file count), compiles ≤Q distinct queries, loads the node table ≤1×";
   "one primed orient performs 0 full-graph loads and 0 adjacency rebuilds"; "a 30-file watcher
   batch loads the node table ≤1×". Counters are deterministic on a pinned fixture, so budgets are
   **exact**, not fuzzy thresholds.
3. **A ratcheting policy for the noisy ones.** For budgets that legitimately grow (payload bytes),
   adopt the rustc-perf pattern: the budget is the recorded baseline; a change that increases it
   updates the baseline in the same PR with the measured delta stated — turning the recurring
   "budget bit again" hand-bump into an explicit, reviewed ratchet.

## Why this is in scope

The substrate's value proposition is deterministic, fast, local structural context; "fast"
currently has no regression floor. A counter-based budget is itself deterministic and local —
the same doctrine as the product — and it is the enforcement mechanism that keeps every scale fix
in this audit from silently regressing. No wall-clock, no new runtime dependency.

## Impact

- Files: a small `src/core/analyzer/perf-counters.ts` (test-only increment hook, no-op when
  inactive) threaded into the counted sites; new plain `.test.ts` budget suites on a pinned
  fixture; `.github/workflows/ci.yml` (the suites run under the existing `test:run`, so likely no
  workflow change — confirm).
- Specs: `project` — 1 ADDED (PerformanceBudgetsAreCounterBasedAndDeterministic).
- No new tool, no runtime behavior change (counters are inert outside the harness). Risk: low —
  the hazard is counter placement drift; keep the increments at a few well-named chokepoints, not
  scattered. Verify: the budget suite passes on the fixture and fails when a deliberate redundant
  parse pass or per-call rebuild is reintroduced.
