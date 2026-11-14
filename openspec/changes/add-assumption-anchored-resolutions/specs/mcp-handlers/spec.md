# mcp-handlers spec delta

## ADDED Requirements

### Requirement: AssumptionAnchoredBoundaryResolutions

The memory store SHALL support an `assumption` type: a deliberately recorded statement that resolves
one disclosed gap, anchored to the symbol that encloses the gap's site. Its content SHALL use a
closed vocabulary (`dispatch-target`, `no-throw`), and a malformed assumption SHALL be refused at
record time. No resolver, heuristic or model SHALL record one, and recording or revoking one SHALL
NOT change the stored graph.

#### Scenario: An agent answers a disclosed dispatch gap

- **GIVEN** an unresolved dispatch site that an answer disclosed as a gap
- **WHEN** the agent records an `assumption` with `dispatch-target` anchored to the enclosing symbol
- **THEN** it is stored in the existing memory store and the stored call graph is byte-identical

#### Scenario: Nothing records assumptions automatically

- **WHEN** `openlore analyze` and every answer run on code with ambiguous dispatch
- **THEN** no assumption exists unless a human or agent recorded one

### Requirement: AssumptionConsumptionCarriesProvenance

`blast_radius`, `analyze_impact`, `find_dead_code`, `analyze_error_propagation` and the `dead` and
`impacts` kinds of `verify_claim` MAY extend their walk with fresh assumptions. Every answer that
used one SHALL carry an `assumptions` list of their ids beside its confidence boundary. A stale,
orphaned or superseded assumption SHALL never be used.

#### Scenario: A used assumption is named

- **GIVEN** a fresh `dispatch-target` assumption that resolves site S to symbol X
- **WHEN** `blast_radius` computes a radius that crosses S
- **THEN** the result includes the callers reached through X and carries `assumptions: [<id>]`

#### Scenario: A stale assumption changes nothing

- **GIVEN** an assumption whose anchor symbol changed after it was recorded
- **WHEN** any of these answers runs
- **THEN** the answer is identical to a run with no assumption and has no `assumptions` list
