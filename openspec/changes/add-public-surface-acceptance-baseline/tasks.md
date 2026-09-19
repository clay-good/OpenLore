# Tasks — add-public-surface-acceptance-baseline

## Implementation
- [x] `--accept` on the CLI: write sorted baseline entries (rule code + symbol + REQUIRED
      justification + optional decision id) under `.openlore/`; refuse without a justification
- [x] Diff mode: report baseline-matched findings as `accepted` (never dropped); flag an
      acceptance anchored to a superseded decision as stale
- [x] Split `breaking` into `breaking-consumed` / `breaking-unconsumed-in-index`, keeping the
      external-consumer boundary on both
- [x] Federation-preset consumer union via `findCrossRepoConsumersBatch`

## Verification
- [x] Baseline tests: refuse without justification; accepted break not re-reported; new break still
      reported; superseded decision anchor flagged stale
- [x] Split tests: consumers → breaking-consumed with the list; zero → breaking-unconsumed-in-index
      with the boundary; federation widens the census
- [ ] Full suite green

## Spec
- [x] `mcp-handlers` delta: ADD AcceptedBreakageBaselineRequiresJustification, ConsumerWeightedBreakingVerdicts
