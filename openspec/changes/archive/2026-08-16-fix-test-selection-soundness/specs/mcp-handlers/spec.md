# mcp-handlers spec delta

## ADDED Requirements

### Requirement: SeedTestCoverageIsIdentityKeyed

The system SHALL decide whether a changed seed symbol has a reaching test by the identity of the
nodes the backward walk actually reached (node id, or at minimum file plus name), never by bare
name membership in any selected test's path. A seed with no reaching test SHALL always receive
the same-file sibling fallback and its low-confidence disclosure caveat, even when another symbol
of the same name elsewhere in the graph is reached by tests.

#### Scenario: A same-named function elsewhere does not shadow an untested seed

- **GIVEN** two functions named `render` in different files, where tests reach only the first
- **WHEN** `select_tests` runs with the second file's `render` as a changed seed
- **THEN** the seed is treated as having no reaching test
- **AND** its same-file sibling tests are selected at low confidence with the fallback caveat

#### Scenario: A genuinely covered seed does not trigger the fallback

- **GIVEN** a seed that the backward walk reaches from at least one test
- **WHEN** the fallback predicate is evaluated
- **THEN** the same-file fallback does not fire for that seed

### Requirement: TestSelectionBoundsAreDisclosed

The system SHALL disclose every bound that narrowed or widened a test selection. When the
backward reachability walk stops at its depth cap while its frontier is non-empty, the response
SHALL carry a truncation receipt naming the depth, and any "may be genuinely untested" conclusion
SHALL be qualified by it. When a changed-symbol seed resolved via the substring fallback rather
than an exact name match, the response SHALL carry the same widening caveat its sibling
`report_coverage_gaps` emits, naming a bounded sample of the widened symbols and pointing to the
complete seed list. Empty changed-symbol names MUST be rejected rather than widening to every
production symbol. Composed consumers (such as
`blast_radius`) SHALL surface these receipts unmodified.

#### Scenario: Truncated reachability carries a receipt

- **GIVEN** a test whose only path to the changed seed exceeds the depth cap
- **WHEN** `select_tests` returns
- **THEN** the response includes a truncation field naming the cap depth
- **AND** the untested-seed caveat is qualified by the truncation

#### Scenario: An exhausted walk carries no truncation receipt

- **GIVEN** a backward walk whose frontier empties before the depth cap
- **WHEN** `select_tests` returns
- **THEN** no truncation receipt is present

#### Scenario: Substring seed widening is disclosed

- **GIVEN** a short changed-symbol name that matches no function exactly
- **WHEN** the seed set is resolved by the substring fallback
- **THEN** the response caveats that the symbol scope may have widened, naming the symbols

#### Scenario: Receipts survive composition

- **GIVEN** `blast_radius` composing a truncated or substring-widened selection
- **WHEN** the briefing is assembled
- **THEN** the truncation and widening receipts appear in the briefing's test section

#### Scenario: Empty symbols do not widen to the whole graph

- **GIVEN** a changed-symbol list containing an empty name
- **WHEN** test selection resolves the requested scope
- **THEN** the request is rejected with an actionable error instead of selecting every symbol
