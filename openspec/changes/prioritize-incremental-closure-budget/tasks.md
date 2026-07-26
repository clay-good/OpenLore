# Tasks — prioritize-incremental-closure-budget

## Implementation

- [ ] Pure, exported comparator over closure candidates: fan-in first, existing
      hub/chokepoint/orchestrator labels as tie-breaks, stable path tie-break last — total and
      deterministic, no new metric or constant
- [ ] Apply the ordering in `mcp-watcher.ts` before the budget is consumed (candidate set is
      already enumerated; this is a sort, not a new traversal)
- [ ] Reuse the shipped `landmark-signals` / `change-significance` classifiers; do not recompute
      or re-weight them
- [ ] Stale-region composition: hub/chokepoint counts + the highest-significance symbol, attached
      to the stale summary
- [ ] Surface the composition in the watcher summary line (`mcp-watcher.ts:658-662`),
      `openlore status`, and the freshness disclosure, using the `briefing_since` tier vocabulary
- [ ] Select the debounced rebuild window from the composition, within the existing bounds; keep
      debounce, coalescing, and at-most-once exactly as they are

## Verification

- [ ] Ordering test: an over-budget fixture with one hub and many leaves recomputes the hub and
      leaves the leaves stale (the inverse of today's arbitrary outcome)
- [ ] Determinism test: identical recomputed/stale partitions across repeated runs, including for
      equal-significance candidates
- [ ] Contract-preservation tests: budget respected; every un-recomputed file marked stale; the
      existing converge-or-flag and freshness-verdict tests unchanged and green
- [ ] Composition test: the summary reports counts, hub count, and the top symbol
- [ ] Rebuild-pressure test: a low-significance stale region schedules no more rebuilds than
      before this change; a hub-containing region converges promptly and still at-most-once
- [ ] Verdict test: composition never promotes a stale-region memory to authoritative
- [ ] Full suite green; `docs/TROUBLESHOOTING.md` updated
