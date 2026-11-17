# cli spec delta

## ADDED Requirements

### Requirement: HandoffBriefingIsDeterministicAndReplayable

`openlore handoff [--json]` SHALL produce the session-succession briefing deterministically: the
same repository state (working tree, index, stores) yields a byte-identical briefing, with no
timestamps or ordering nondeterminism, so a successor can regenerate and diff it. A clean
working tree SHALL return an explicit nothing-in-flight statement with the current lease state,
never an empty payload, and an index trailing the working tree SHALL carry the standard
staleness disclosure. The command SHALL read only the repository — never any conversation
transcript — and SHALL NOT persist briefings.

#### Scenario: Regeneration is byte-identical

- **GIVEN** a repository with uncommitted edits and no further changes
- **WHEN** `openlore handoff --json` runs twice
- **THEN** the two outputs are byte-identical

#### Scenario: A clean tree says so

- **GIVEN** a clean working tree
- **WHEN** `openlore handoff` runs
- **THEN** the output states nothing is in flight and reports the lease state — not an empty
  object
