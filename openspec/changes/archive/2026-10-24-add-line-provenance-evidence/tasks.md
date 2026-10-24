# Tasks — add-line-provenance-evidence

## Implementation
- [ ] Attribution-record reader: discover git notes ref / `.agent-trace/` sidecars; tolerant
      parse (malformed record → skipped with a counted disclosure, never a throw); no network
- [ ] Span projection at analyze/watcher: line ranges → persisted symbol spans → per-symbol
      `authorship` fact `{kind, coveredLines, totalLines, lastAgentRecord?}` in a sidecar table;
      stale/unmappable ranges degrade to `unknown`
- [ ] Surface authorship on `blast_radius`, `briefing_since`, `report_coverage_gaps` (compound
      `agent-authored` + `no reaching test` label); `basis: "attribution-records (unverified)"`
      mandatory on every surfaced value
- [ ] Register `unreviewed-agent-hub` advisory finding (existing hub classifier × all-agent/no-
      human set predicate; no new constant)
- [ ] `verify_claim` kind `authored-by` with record-coverage receipt

## Verification
- [ ] Fixture repo with synthetic records: projection correctness, partial-coverage disclosure,
      malformed-record skip count, absent-records byte-identical behavior
- [ ] Finding fires only on hub × all-agent × zero-human; never on partial coverage
- [ ] verify_claim `authored-by` confirmed/refuted/unverifiable paths
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD AuthorshipFactsAreIngestedNeverInferred
- [ ] `mcp-handlers` delta: ADD AuthorshipIsADisclosedEvidenceDimension
