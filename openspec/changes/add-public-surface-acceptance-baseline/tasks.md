# Tasks — add-public-surface-acceptance-baseline

## Implementation
- [ ] `--accept` on the CLI: write sorted baseline entries (rule code + symbol + REQUIRED
      justification + optional decision id) under `.openlore/`; refuse without a justification
- [ ] Diff mode: report baseline-matched findings as `accepted` (never dropped); flag an
      acceptance anchored to a superseded decision as stale
- [ ] Split `breaking` into `breaking-consumed` / `breaking-unconsumed-in-index`, keeping the
      external-consumer boundary on both
- [ ] Federation-preset consumer union via `findCrossRepoConsumersBatch`

## Verification
- [ ] Baseline tests: refuse without justification; accepted break not re-reported; new break still
      reported; superseded decision anchor flagged stale
- [ ] Split tests: consumers → breaking-consumed with the list; zero → breaking-unconsumed-in-index
      with the boundary; federation widens the census
- [ ] Full suite green

## Spec
- [ ] `mcp-handlers` delta: ADD AcceptedBreakageBaselineRequiresJustification, ConsumerWeightedBreakingVerdicts
