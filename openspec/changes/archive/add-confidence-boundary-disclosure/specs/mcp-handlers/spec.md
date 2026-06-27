# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ConfidenceBoundaryOnConclusions

Every conclusion-shaped answer (`analyze_impact`, `find_path`, `find_dead_code`, `get_subgraph`,
`select_tests`, `recall`, `trace_execution_path`) SHALL carry a deterministic `confidenceBoundary`
describing its epistemic basis: the portion resting on directly-resolved edges, the portion resting on
synthesized edges (named by their `synthesizedBy` rule), and any **known-unknowable** crossings — a
traversal that passed a reflection or computed-dispatch boundary, or, under federation, an unindexed
repository. The boundary SHALL be categorical labels and counts, never a blended confidence score, and
SHALL be additive metadata that callers may ignore.

#### Scenario: A clean answer reports a clean boundary

- **GIVEN** a query answered entirely via directly-resolved edges against a current index
- **WHEN** the response is produced
- **THEN** its `confidenceBoundary` reports only directly-resolved basis and no known-unknowable crossing

#### Scenario: A boundary-crossing answer is flagged, not hidden

- **GIVEN** a `find_dead_code` query whose subject is reachable only across a reflection boundary
- **WHEN** the response is produced
- **THEN** the symbol is not reported as confidently dead, and the `confidenceBoundary` names the
  reflection crossing as known-unknowable

### Requirement: StalenessBoundary

When the index fingerprint lags the working tree, every conclusion SHALL carry a staleness marker
naming the index's build commit and the count of files changed since, reusing the freshness machinery.
A current index SHALL produce no staleness marker.

#### Scenario: A stale index is disclosed

- **GIVEN** an index built at commit X and a working tree with N files changed since X
- **WHEN** any conclusion is produced
- **THEN** the response discloses "computed against the index at commit X; N files changed since"
