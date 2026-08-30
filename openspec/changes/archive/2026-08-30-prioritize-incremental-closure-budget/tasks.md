# Tasks — prioritize-incremental-closure-budget

## Implementation

- [x] Pure, exported comparator: strict lexicographic (fanIn desc, fanOut desc, path asc). The
      hub/chokepoint labels are NOT tie-break levels — each is monotone in those counters, so the
      level would be dead code inviting a future blend
- [x] File-level aggregation rule stated explicitly (max fan-in over internal non-test nodes; the
      same node's fan-out; no internal nodes ⇒ last), since candidates are FILES and the
      classifiers are per-SYMBOL. Name `significance-scorer.ts` if reusing it instead
- [x] Apply ordering WITHIN each phase (direct callers; then the Class-P rebind set), never
      across — phase two is not enumerable until phase one is built
- [x] Test-class starvation guard: tests carry ~zero fan-in by construction, so a pure fan-in
      order starves test→production edges forever; rank tests within their own class with a
      bounded budget share, or disclose the reachability degradation
- [x] Lift `HUB_THRESHOLD` (module-private at `call-graph.ts:114`, already duplicated as
      `DEFAULT_HUB_THRESHOLD` in `api/audit.ts:32`) to `src/constants.ts` rather than declare it a
      third time — otherwise "no new tuning constant" is violated by the implementation
- [x] Do NOT call `computeLandmarkSignals` (needs a `SerializedCallGraph`) or
      `labelChangeSignificance` (needs git churn per file) on the watch path; order from the
      `fanIn`/`fanOut` already on the loaded internal node table
- [x] Rebuild window: MONOTONE only — a later trigger may lengthen an armed window, never shorten
      it; preserve debounce, coalescing, and at-most-one-in-flight
- [x] Neutralize terminal control sequences on the watcher's raw stderr writes (repo-derived
      symbol names now appear there; the shipped guard covers only the shared CLI sinks)
- [x] Put the composition in a SHARED module — `scale-analyze-to-workspace-shards` adds a second
      stale-region producer that must reuse it
- [x] Stale-region composition: hub/chokepoint counts + the highest-significance symbol, attached
      to the stale marking and persisted with it
- [x] Apply the ordering in `mcp-watcher.ts` before each phase consumes its share of the budget
      (the candidates are already enumerated per phase; this is a sort, not a new traversal)
- [x] Surface the composition where stale regions are ALREADY reported: the watcher summary
      (`mcp-watcher.ts:658-662`, currently debug-gated) and the per-anchor stale-region marker on
      freshness verdicts. No new command or tool (`openlore status` does not exist on `main`)

## Verification

- [x] Ordering test: an over-budget fixture with one hub and many leaves recomputes the hub and
      leaves the leaves stale (the inverse of today's arbitrary outcome)
- [x] Determinism test: identical recomputed/stale partitions across repeated runs, including for
      equal-significance candidates
- [x] Contract-preservation tests: budget respected; every un-recomputed file marked stale; the
      existing converge-or-flag and freshness-verdict tests unchanged and green
- [x] Composition test: the summary reports counts, hub count, and the top symbol
- [x] Rebuild-pressure test: a low-significance region schedules no more rebuilds than today; a
      hub region converges promptly, still at-most-once
- [x] Monotonicity test: a hub trigger arriving after a HEAD-change trigger does NOT shorten the
      armed window, and exactly one rebuild runs
- [x] Under-budget no-op test: ordering is unobservable when the closure fits
- [x] Control-sequence test: a hostile symbol name in a stale region cannot forge the summary
- [x] Verdict test: composition never promotes a stale-region memory to authoritative
- [x] Full suite run (9,048 pass; 31 known host-dependency failures); `docs/TROUBLESHOOTING.md` updated
