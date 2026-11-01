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

### Requirement: SessionCountsAreExposedAsData

`openlore status --json` SHALL report per-session counts of symbols whose body changed with an
unchanged signature, symbols whose signature changed (each symbol counted in exactly one of the
two), changed public exports, changed contract elements, and changed IaC resources. The system SHALL
NOT compute a percentage, score, or threshold over these counts.

#### Scenario: Counts, not budgets

- **GIVEN** a session that changed the bodies of two functions and the signature of a third,
  exported function
- **WHEN** `openlore status --json` runs
- **THEN** it reports body-only 2, signature-changed 1, exports-changed 1, and no percentage or
  threshold field
