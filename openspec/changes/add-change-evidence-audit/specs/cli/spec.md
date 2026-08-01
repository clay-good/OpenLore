# cli spec delta

## ADDED Requirements

### Requirement: ChangeStatusIsComputedFromDocumentedEvidence

`openlore change-status` SHALL compute each open change's status from the documented evidence
signals — the `change: <name>` marker scan over `src/` (with file:line receipts) and the
per-requirement presence of the change's delta requirements in the target main spec (keyed by
requirement name within the target domain) — via a fixed verdict rule table (`built`,
`built-unmarked` with the verify-against-code caveat verbatim, `partially-built`, `unbuilt`,
`not-assessed` with the parse error). Every output SHALL state that the verdict reflects
evidence signals, not runtime correctness. `--table` SHALL emit only the open-changes table
body in the audit file's format to stdout, and tasks.md checkboxes SHALL appear only as a
display column, never as a verdict input.

#### Scenario: Synced-but-unmarked carries the caveat

- **GIVEN** a change whose delta requirements are all present in the main spec and whose name
  appears in no `src/` marker
- **WHEN** `change-status` runs on it
- **THEN** the verdict is `built-unmarked` with the per-requirement sync receipts and the
  verify-against-code caveat, and the evidence-not-correctness statement is present

#### Scenario: A malformed delta is not-assessed

- **GIVEN** a change whose spec delta fails to parse
- **WHEN** `change-status` runs
- **THEN** the verdict is `not-assessed` with the parse error — never `unbuilt`
