# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ServedContractsAndResourcesCarryCanonicalHashes

Contract elements and IaC resources SHALL be tracked in the ledger like code symbols, with a hash
computed as SHA-256 over the element's parsed fields serialized with sorted keys, so that a
formatting-only change does not change the hash and a changed field, path, or attribute does. The
background-change note SHALL name such an element by its address and file.

#### Scenario: A teammate edits the spec the agent read

- **GIVEN** a session that was served the operation `POST /v1/checkout` from `openapi.yaml`, and a
  second process that then adds a required property to its request body
- **WHEN** the agent makes its next tool call
- **THEN** the note names `POST /v1/checkout` and `openapi.yaml`

#### Scenario: Re-indenting the spec is not a change

- **GIVEN** the same session, and a second process that only re-indents `openapi.yaml`
- **WHEN** the agent makes its next tool call
- **THEN** no note names the operation

## MODIFIED Requirements

### Requirement: SessionCountsAreExposedAsData

`openlore status --json` SHALL report, for the elements the agent's edits changed (as the after-edit
hook attributes them; withheld without that report), counts of body-only changes, signature changes,
unclassified changes (signature unreadable or possibly cut), symbols first seen after the agent
edited them, declared contract elements changed, and declared infrastructure resources changed (each
element in exactly one), and of changed exported symbols. A declaration has no declaration line to
compare, so it SHALL be counted on its own line rather than as an unclassified symbol. It SHALL NOT
compute a percentage, score, or threshold.

#### Scenario: Counts, not budgets

- **GIVEN** a session that changed the bodies of two functions and the signature of a third,
  and two of the three are exported
- **WHEN** `openlore status --json` runs
- **THEN** it reports body-only 2, signature-changed 1, exports-changed 2, and no percentage or
  threshold field

#### Scenario: A declared operation is counted as what it is

- **GIVEN** a session in which the agent changed one declared OpenAPI operation
- **WHEN** `openlore status --json` runs
- **THEN** it reports one contract element changed and no unclassified change
