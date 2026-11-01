# mcp-handlers spec delta

## ADDED Requirements

### Requirement: EditsAfterTheLastTestRunAreNamed

When the harness payloads delivered to OpenLore's after-tools hook (which receives every tool
call, not only edits) include a shell command that
matches a test command the repository declares (a package test script, a CI run step, a test build
target) or a runner from a closed list, the session ledger SHALL record the time of the run, its exit
status when the payload carries one, and the content hashes of the session's edited symbols at that
moment. The before-stop receipt SHALL name the symbols edited after the most recent recorded run and
the tests that reach them. The system SHALL NOT run any test. When no hook payloads were received,
the fact SHALL be withheld and the reason stated.

#### Scenario: An edit after the test run is named

- **GIVEN** a session that edits `parseConfig`, runs `npm test`, then edits `loadDefaults`
- **WHEN** the before-stop hook runs
- **THEN** the receipt names `loadDefaults` and the tests that reach it, and does not name
  `parseConfig`

#### Scenario: No payloads means no claim

- **GIVEN** a harness that delivers no after-tools payloads
- **WHEN** the before-stop receipt is built
- **THEN** it states that test runs are not observed, rather than naming every edited symbol

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

### Requirement: LeaseTokensAndSessionCountsAreExposedAsData

`orient` and `recall` SHALL return a `leaseToken` that identifies the set of (address, hash) pairs
they served and that any process on the same clone can resolve through the ledger store while the
session lives. `openlore status --json` SHALL report per-session counts of symbols whose body changed
with an unchanged signature, symbols whose signature changed (each symbol counted in exactly one of
the two), changed public exports, changed contract elements, and
changed IaC resources. The system SHALL NOT compute a percentage, score, or threshold over these
counts.

#### Scenario: A sub-agent checks its parent's lease

- **GIVEN** a `leaseToken` returned to a parent agent by `orient`, and a later edit to one of the
  served symbols
- **WHEN** a sub-agent in another process asks `verify_claim` whether that lease is current
- **THEN** the verdict is refuted and names the changed symbol

#### Scenario: Counts, not budgets

- **GIVEN** a session that changed the bodies of two functions and the signature of a third,
  exported function
- **WHEN** `openlore status --json` runs
- **THEN** it reports body-only 2, signature-changed 1, exports-changed 1, and no percentage or
  threshold field
