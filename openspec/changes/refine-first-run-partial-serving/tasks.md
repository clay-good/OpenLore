# Tasks — refine-first-run-partial-serving

## Implementation
- [x] Partial index module (`src/core/runtime/partial-index.ts`): flush, re-stamp, read,
      clear, and the completeness receipt. Written OUTSIDE the analysis directory (under
      `.openlore/runtime/partial-analysis/`) so no artifact reader, exporter, attester, or
      fingerprint can see it; commits each flush through the same `publishGeneration`
      content-digest primitive the real analysis uses
- [x] Flush lane in `analysis-core.ts`: flush at the dependency-graph and extractors phase
      boundaries, re-stamp on the artifacts-phase heartbeat, armed only when the caller opts
      in AND no published generation exists. Wholly fail-soft — no flush failure can reach the
      analysis it is a side effect of
- [x] Lane gating: `--partial-serving` (hidden) passed by the background auto-init build,
      default-on for an interactive `openlore analyze`, off under `--embedded`/CI
- [x] Absent-case serving in `readCachedContext`: fall back to the partial index only when no
      analysis artifact is present, never to mask one that failed a gate
- [x] Completeness receipt on every response (`partialDisclosureForResponse`), for both an
      answer computed from the partial index and a not-ready result during a live build
- [x] `ConfidenceBoundary.partial` marker, folded into `complete`
- [x] Negative-conclusion guard: `find_dead_code` and `report_coverage_gaps` withhold and cite
      the partial boundary
- [x] Export/bundle/import guards refuse a partial index explicitly (`BundleError`
      `partial-index`), on top of the structural isolation
- [x] Completion path: publish first, then clear the partial index — a failed publish keeps it

## Verification
- [x] Serving test: an index-absent repository with a live partial index answers from it with
      the receipt; one without still gets the guidance path
- [x] Integrity tests: tampered bytes, uncommitted bytes, a dead owner, a stale stamp, and a
      malformed stamp are each refused rather than served
- [x] Precedence test: a present analysis artifact is never masked by a partial index
- [x] Negative-guard test: `find_dead_code` / `report_coverage_gaps` withhold on a partial
      index and mark the boundary incomplete
- [x] Convergence test: flushing and non-flushing builds of the same tree produce
      byte-identical artifacts, and no partial index survives the publish
- [x] Guard test: `buildBundle` refuses while a build is in flight; `parseBundle` refuses a
      bundle whose context carries a partial stamp
- [x] Fail-soft test: an unwritable partial location produces no index, no throw, and a
      normally published analysis
- [x] Full suite green (unit, equivalence, integration, lint, typecheck)

## Spec
- [x] `architecture` delta: ADD FirstRunServesPartialWithACompletenessReceipt

## Deliberately not built
- [x] A partial CALL GRAPH. Pass 1 extracts every file before the merge and resolution passes
      run, so a mid-pass flush would have to re-run merge+resolution over a prefix — extra work
      on every build, and a second code path through the machinery the determinism oracle
      guards. The partial index therefore carries repository structure and the dependency
      graph, and names the call graph and the search index as not yet built rather than
      implying it has them. Recorded here so a later change starts from the reason, not the gap.
