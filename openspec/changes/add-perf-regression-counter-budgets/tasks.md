# Tasks — add-perf-regression-counter-budgets

## Implementation
- [x] Use the existing test-only call-graph parse/Query/type-inference counters, and add a scoped
      hook in src/core/analyzer/perf-counters.ts for the shared source-parse boundary, full
      node-table loads, adjacency builds, EdgeStore statement prepares, and atomic artifact
      payload bytes. The hook is inert outside a scope; it does not re-encode production payloads.
- [x] Thread increments into the counted chokepoints (few, well-named — not scattered)
- [x] Plain .test.ts budget suites on pinned fixtures with EXACT budgets (deterministic):
      analyze parse count == graphed file count, <=Q distinct queries, node table loaded <=1x;
      one primed orient does 0 full-graph loads / 0 adjacency rebuilds; a 30-file watcher batch
      loads the node table <=1x
- [x] Ratchet policy for legitimately-growing budgets (payload bytes): baseline-recorded, a PR
      that increases it updates the baseline with the measured delta stated

## Verification
- [x] The budget suite passes on the fixture at current main (after the scale fixes land)
- [x] Negative test: a deliberately reintroduced extra full node-table load makes its exact
      budget fail; existing parse/query bounds catch a redundant extraction pass
- [x] Counters are inert (no counter mutations or extra payload encoding) when inactive
- [x] Suites run under CI's existing test:unit and test:equivalence steps (no workflow change)
- [ ] Full suite green

## Spec
- [x] `project` delta: ADD PerformanceBudgetsAreCounterBasedAndDeterministic
