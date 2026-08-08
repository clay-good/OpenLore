# api spec delta

## ADDED Requirements

### Requirement: ApiDecisionSyncRespectsStatusTransitions

`openloreSyncDecisions` SHALL apply the decision status-transition rules when given explicit
ids: a decision in a terminal `rejected` state SHALL NOT be resurrected to `approved` and
synced into the specs. Only a legitimate transition results in a sync.

#### Scenario: A rejected decision cannot be synced by id

- **GIVEN** a decision a human rejected
- **WHEN** an embedder calls `openloreSyncDecisions({ ids: [that id] })`
- **THEN** the decision is not approved or written into the specs

### Requirement: ApiGenerateDoesNotMutateProcessTls

`openloreGenerate` SHALL NOT disable TLS certificate verification for the host process. TLS
behavior SHALL be scoped to the LLM service path and keyed on the LLM `sslVerify` setting, not
on the embedding endpoint's `skipSslVerify`.

#### Scenario: An embedding TLS setting does not weaken the host process

- **GIVEN** a config with `embedding.skipSslVerify: true` and default LLM TLS
- **WHEN** an embedder calls `openloreGenerate`
- **THEN** the host process's global TLS verification is unchanged
