# mcp-handlers spec delta

## ADDED Requirements

### Requirement: AuthorshipIsADisclosedEvidenceDimension

Conclusions that surface per-symbol authorship (`blast_radius`, `briefing_since`,
`report_coverage_gaps`, and the `verify_claim` `authored-by` kind) SHALL present it as a
disclosed evidence dimension: every surfaced value carries the basis
`attribution-records (unverified)` and the record coverage for that symbol. The registered
advisory finding `unreviewed-agent-hub` SHALL fire only when a symbol the existing landmark
classifier labels a hub has all covered lines agent-attributed and no human-attributed line —
a set predicate over existing classifications, never a new threshold. A symbol with partial or
absent coverage SHALL never trigger the finding, and no conclusion SHALL present authorship as
verified identity.

#### Scenario: A briefing labels an agent-authored hub

- **GIVEN** attribution records fully covering hub function `h` with agent attribution and no
  human-attributed line
- **WHEN** `blast_radius` includes `h` and the finding pipeline runs
- **THEN** `h` carries authorship `agent` with the unverified basis and coverage stated, and
  `unreviewed-agent-hub` is emitted as an advisory finding citing the hub classification

#### Scenario: Partial coverage never fires the finding

- **GIVEN** a hub whose attribution records cover 60% of its lines, all agent-attributed
- **WHEN** the finding pipeline runs
- **THEN** no `unreviewed-agent-hub` finding is emitted, and the surfaced authorship states the
  partial coverage
