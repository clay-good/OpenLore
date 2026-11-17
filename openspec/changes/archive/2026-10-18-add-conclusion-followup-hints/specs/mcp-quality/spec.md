# mcp-quality spec delta

## ADDED Requirements

### Requirement: DataDependentFollowupHints

Conclusion tool responses SHALL carry at most two deterministic follow-up hints, emitted only
when a rule in a closed, source-declared rule table matches fields already present in that
response's payload. Each hint SHALL name the suggested tool and cite the triggering field and its
value (a receipt, not advice). Rules SHALL reference existing classifier outputs and constants
only — a rule SHALL NOT introduce a new threshold or re-test an existing one downstream of the
classifier that computed it. The rule table SHALL be guarded in CI so that a rule naming an
unregistered tool, on either side, fails the build. Hints SHALL be attached at dispatch, as a
`followUp` array, and never to an error response. Hints are the
data-dependent complement to the static NoRedundantConclusions sibling cross-references in tool
descriptions; they are advisory payload content and SHALL never gate or block. Hint emission
SHALL be deterministic: the same payload yields the same hints.

#### Scenario: A hub search hit routes to impact analysis

- **GIVEN** a `search_code` response whose top hit is classified a hub (`isHub: true`)
- **WHEN** the response is returned
- **THEN** it carries a hint naming `analyze_impact` and citing the hit's actual fan-in value as
  the trigger

#### Scenario: No matching data, no hint

- **GIVEN** a `search_code` response whose hits are all low-fan-in utilities
- **WHEN** the response is returned
- **THEN** it carries no follow-up hints — hints never fire unconditionally

#### Scenario: The hint cap holds under multiple matches

- **GIVEN** a response whose fields satisfy three or more rules
- **WHEN** hints are evaluated
- **THEN** exactly two hints are emitted, selected by declared table order, deterministically

#### Scenario: The table cannot drift open

- **GIVEN** a new rule added to the table that names a tool not in the tool registry
- **WHEN** the CI guard runs
- **THEN** the build fails until the rule names a real tool and a real payload field
