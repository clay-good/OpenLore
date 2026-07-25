# mcp-quality spec delta

## ADDED Requirements

### Requirement: ConclusionShapeIsEnforcedAtDispatch

The conclusion-over-graph contract SHALL be enforced on live responses, not only on synthetic test
objects: the tool dispatch path SHALL run the conclusion-shape check (`assertConclusionShape`) on
every successful response from a `conclusion`-classified tool before serialization, on both
transports (MCP stdio and the serve HTTP daemon). Enforcement SHALL be fail-safe in production —
a violation is logged and disclosed on the response as a governance finding with a stable
registered code (`conclusion-shape-violation`, advisory by default per AdvisoryByDefault; an
operator MAY escalate it via `enforcement.policy`) while the computed result is still returned —
and strict in CI/tests, where a violation fails the suite. `explicit-topology` tools remain
exempt by classification.

#### Scenario: A handler regresses into a graph dump in production

- **GIVEN** a `conclusion`-classified tool whose handler returns both a top-level `nodes[]` and a
  top-level `edges[]`
- **WHEN** the tool is dispatched in production (advisory mode)
- **THEN** the response is still returned to the agent
- **AND** it carries a `conclusion-shape-violation` governance finding naming the tool and the
  violating shape, and the violation is logged

#### Scenario: The same regression fails CI

- **GIVEN** the same regressing handler
- **WHEN** the dispatch path runs in strict mode (CI/tests)
- **THEN** the conclusion-shape check throws and the test suite fails, naming the tool

#### Scenario: Bounded provenance passes untouched

- **GIVEN** a conclusion tool citing a small number of provenance edges (within
  `MAX_PROVENANCE_EDGES`) to explain its answer
- **WHEN** the response is dispatched
- **THEN** no violation is raised and no disclosure is attached

### Requirement: AdjacentConclusionsCrossReferenceAllPairs

Every pair of tools whose conclusions could be read as answering the same question SHALL be
registered in the adjacency table (`ADJACENT_TOOL_GROUPS`), including the point-to-point path pair
(`find_path`, `trace_execution_path`) and the spec-parity pair (`audit_spec_coverage`,
`check_spec_drift`). Within a registered group, **every** member's published description SHALL
name **every** other member and state the distinct question it answers — all pairs, not merely one
sibling — and the CI guard SHALL enforce the all-pairs property so a 3+-member group cannot pass
on a single mention. Adjacent tools returning distinct conclusions remain deliberately unmerged.

#### Scenario: The default-surface path pair is mutually legible

- **GIVEN** the `find_path` and `trace_execution_path` descriptions published in `tools/list`
- **WHEN** the adjacency guard runs
- **THEN** each description names the other and states its distinct question (cheapest-route
  selectors versus all-paths debugging trace)

#### Scenario: A member omitting one sibling in a larger group fails CI

- **GIVEN** a registered 3-member adjacency group where one member's description names only one of
  its two siblings
- **WHEN** the all-pairs guard runs
- **THEN** it fails, naming the member and the missing sibling

#### Scenario: A comment-paired sibling cannot bypass registration

- **GIVEN** two tools whose classification rationale pairs them (e.g. "like its sibling …") but
  which share no registered adjacency group
- **WHEN** the pair is identified
- **THEN** the pair is registered in `ADJACENT_TOOL_GROUPS` and covered by the all-pairs guard,
  rather than remaining adjacent only in a comment
