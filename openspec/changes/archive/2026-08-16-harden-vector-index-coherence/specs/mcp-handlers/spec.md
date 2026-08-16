# mcp-handlers spec delta

## ADDED Requirements

### Requirement: SearchDisclosesDegradedVectorIndex

The `search_code` and `suggest_insertion_points` handlers SHALL include an optional
`indexDegraded` string when the vector index records, or the live process observes, an incremental
update whose add and rollback both failed. The disclosure SHALL use the remediation
`Index degraded — re-run "openlore analyze".` and SHALL remain present on normal and literal-text
fallback results until a successful full rebuild establishes a healthy index. Healthy responses
SHALL omit the field.

#### Scenario: Search result carries persisted degradation

- **GIVEN** an incremental vector-index update whose add and rollback both failed
- **WHEN** `search_code` or `suggest_insertion_points` serves a result
- **THEN** the response includes `indexDegraded` with the full-rebuild remediation

#### Scenario: Literal fallback does not hide degradation

- **GIVEN** a degraded vector index and a symbol query with no symbol matches
- **WHEN** `search_code` returns literal-text fallback matches
- **THEN** the fallback response still includes `indexDegraded`

#### Scenario: Healthy search omits the warning

- **GIVEN** a successful full vector-index rebuild with no degraded marker
- **WHEN** either search handler serves a result
- **THEN** the response omits `indexDegraded`
