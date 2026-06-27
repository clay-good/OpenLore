# mcp-handlers spec delta

## ADDED Requirements

### Requirement: StructuralClaimVerification

The system SHALL provide a capability that accepts a structured structural claim
(`{ kind: 'calls' | 'reaches' | 'dead' | 'impacts' | 'safe-to-change', subject, object? }`) and returns
a deterministic `{ verdict: 'confirmed' | 'refuted' | 'unverifiable', receipt }`. The verdict SHALL be
computed by the existing deterministic analysis for that claim kind, never by an LLM. A `confirmed` or
`refuted` verdict SHALL carry a receipt — the backing edges, spans, and content hashes (grounding-
certificate shape) plus the index commit — suitable for the agent to cite to a human. The capability
SHALL be conclusion-shaped (verdict + receipt, never a graph) and registered only in an opt-in preset.

#### Scenario: A false claim is refuted with a receipt

- **GIVEN** a claim that function A calls function B, when no such edge exists
- **WHEN** the claim is verified
- **THEN** the verdict is `refuted` with a receipt referencing the index commit and the relevant spans

#### Scenario: A blind-spot claim is unverifiable, not fabricated

- **GIVEN** a `dead` claim about a symbol reachable only across a reflection boundary
- **WHEN** the claim is verified
- **THEN** the verdict is `unverifiable` with the boundary named, never `confirmed` or `refuted`
