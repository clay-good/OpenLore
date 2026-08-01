# mcp-handlers spec delta

## ADDED Requirements

### Requirement: PriorChurnIsMeasuredBeforeTheBriefedRange

The system SHALL compute `briefing_since`'s prior-churn evidence — `priorChurn`, its
`volatilityLevel`, and the `historyAvailable` predicate that gates the `surprising-change` tier —
exclusively over commits at or before the briefing's resolved base ref, never over commits inside
the briefed range itself. A symbol's significance within the briefed range SHALL NOT be able to
demote its own surprise tier.

#### Scenario: A dormant hub hammered in the briefed range is surprising

- **GIVEN** a hub whose file was untouched for hundreds of commits before the base ref
- **AND** many commits touching it within the briefed range
- **WHEN** `briefing_since` ranks the change set
- **THEN** the symbol's prior churn reflects only pre-base commits
- **AND** the `surprising-change` tier is assigned

#### Scenario: A history that is entirely the briefed range has no "before"

- **GIVEN** a repository whose full commit history lies within the briefed range
- **WHEN** `briefing_since` evaluates history availability
- **THEN** `historyAvailable` is false
- **AND** the surprise label is withheld with the shallow-history receipt

#### Scenario: Other churn consumers are unchanged

- **GIVEN** a caller of the change-coupling miner that supplies no start ref
- **WHEN** churn is mined
- **THEN** the result is identical to the pre-change behavior

### Requirement: BriefingCapabilityClaimsAreCurrent

The system SHALL NOT embed in any tool response a claim that a shipped capability does not exist.
`blast_radius`'s federation block SHALL either evaluate cross-repo impact by forwarding the
opt-in federation scope to its composed test selection, or state truthfully that this tool does
not evaluate it and name the tool that does — never that the capability is "not yet shipped".

#### Scenario: The default-surface briefing tells the truth about federation

- **GIVEN** `blast_radius` on the default preset
- **WHEN** the briefing is returned
- **THEN** its federation block contains no claim that multi-repo federation is unshipped
- **AND** it either carries an evaluated result or names `select_tests` with `federation: true`

#### Scenario: Forwarded federation reaches the composed selection

- **GIVEN** the implementation forwards a federation option
- **WHEN** `blast_radius` is called with federation opted in
- **THEN** the composed test selection runs with the federation scope
- **AND** the briefing carries its cross-repo result and coverage disclosures
