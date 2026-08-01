# mcp-handlers spec delta

## ADDED Requirements

### Requirement: AnchoredFactsCarryImmutableOrigin

Every memory and decision SHALL carry an origin class from the closed set `human-approved`,
`agent-recorded`, `imported-bundle`, `federated-remote`, stamped immutably at write time by the
writing path — never inferred, never editable afterward. A record written before this change
SHALL read as `agent-recorded` with the assumption disclosed. Every surface that serves an
anchored fact (recall, decision verification, the commit gate, injected briefings) SHALL disclose
its origin class. A fact of origin `imported-bundle` or `federated-remote` SHALL be served
advisory-only — never as clean authoritative context — until it is re-earned deterministically in
the local repository (its anchors, and claims when present, re-verify against the local graph) or
promoted by an explicitly human act, with the quarantine exit disclosed. When a gated conclusion
is materially informed by a fact whose origin is not `human-approved`, the system SHALL emit the
registered governance finding `untrusted-origin-influence`, advisory by default and classified by
the operator's enforcement policy.

#### Scenario: Origin is stamped and immutable

- **GIVEN** a memory recorded by `remember`
- **WHEN** it is stored, updated in place, and recalled
- **THEN** its origin is `agent-recorded` at every step and no update path can change it

#### Scenario: An imported fact is quarantined until re-earned

- **GIVEN** a memory ingested from an imported bundle
- **WHEN** `recall` runs before any local re-verification
- **THEN** the memory is served advisory-only with origin `imported-bundle` disclosed
- **AND** after its anchors re-verify against the local graph, it is served normally with the
  quarantine exit disclosed

#### Scenario: Untrusted influence on a gate is a finding

- **GIVEN** a commit gate whose verdict cites a decision of origin `imported-bundle`
- **WHEN** the gate evaluates
- **THEN** the `untrusted-origin-influence` finding is emitted with the fact's id and origin
- **AND** the gate blocks only if the operator's policy classifies that code as blocking

#### Scenario: Legacy records disclose the assumed floor

- **GIVEN** a store written before this change
- **WHEN** its records are served
- **THEN** each reads origin `agent-recorded` with the assumption disclosed, and no record is
  silently presented as `human-approved`
