# Tasks — refine-first-run-partial-serving

## Implementation
- [ ] Partial flush lane in the artifact generator: at phase boundaries + every N files during
      an index-absent interactive build, write current artifacts atomically with the
      completeness stamp `{filesExtracted, filesTotal, phase, partial: true}` (reuse
      `atomicWriteFile` + the analysis lock; `--embedded`/CI keeps single-write)
- [ ] Absent-case serving in `cold-start-bootstrap.ts`: extend the stale-serving contract
      (`:154-165`) so `index-absent` + newest partial artifact → serve with receipt instead of
      "run analyze" guidance
- [ ] Epistemic-lease partial boundary: completeness figure + "hubs-first;
      invisible-not-absent" note on every response while partial
- [ ] Negative-conclusion guard: `find_dead_code`, `report_coverage_gaps`, no-caller claims
      withheld/downgraded while `partial: true`, boundary cited
- [ ] Export/bundle/attest/import guards reject partial artifacts explicitly
- [ ] Completion path: final write byte-identical to single-write (determinism oracle), clears
      partial state, lease resumes normal lifecycle

## Verification
- [ ] Serving test: mid-build `orient` answers from the partial artifact with the receipt; the
      same call pre-first-flush still gets the guidance path
- [ ] Hubs-first test: the first flush of this repo contains the top significance-scored files
- [ ] Negative-guard test: a symbol whose only caller is unindexed is never reported dead /
      uncovered while partial
- [ ] Convergence test: flushing and non-flushing builds of the same tree produce byte-identical
      final artifacts
- [ ] Guard test: `openlore export` / bundle / import refuse a partial artifact with an
      explicit reason
- [ ] Full suite green

## Spec
- [ ] `architecture` delta: ADD FirstRunServesPartialWithACompletenessReceipt
