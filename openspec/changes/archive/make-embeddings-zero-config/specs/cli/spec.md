# cli spec delta

## ADDED Requirements

### Requirement: FirstRunNeverBlocksOnEmbeddings

The first-run flow (`openlore install` and `openlore analyze`) SHALL complete with a fully working
first-class keyword index without any embedding configuration, network access, or API key. Embeddings
SHALL never be on the critical path of obtaining a working index; the semantic upgrade SHALL be offered
but never required.

#### Scenario: Clean install with no embedding setup produces a working index

- **GIVEN** a fresh repository with no embedding configuration
- **WHEN** the user runs `openlore install`
- **THEN** a first-class keyword index is built and `orient` / `search_code` work, with no embedding
  endpoint, key, or network required

### Requirement: LocalEmbeddingsEnabledByOneCommand

The CLI SHALL provide a single command to enable on-device semantic embeddings with no endpoint and no
API key (for example `openlore embed --local`), which configures the local provider and builds (or
rebuilds) the semantic index, lazily fetching and caching the pinned local model on first use. Enabling
local embeddings SHALL require no further configuration beyond that one command.

#### Scenario: One command turns on local semantic search

- **GIVEN** a repository with a working keyword index
- **WHEN** the user runs `openlore embed --local`
- **THEN** the local model is fetched and cached, the semantic index is built on-device, and
  subsequent searches use semantic ranking — with no endpoint or API key configured

### Requirement: RetrievalModeIsStatedPlainlyAndLowNoise

The CLI SHALL state the active retrieval mode (`keyword`, `local-semantic`, or `remote-semantic`)
plainly where it is useful (for example in `analyze` and `orient` summaries), and SHALL NOT emit
repeated degraded-fallback warnings for the keyword default. A one-time notice SHALL be emitted only
when a *configured* expectation fails — specifically, when a remote embedding endpoint is configured
but unreachable — not when keyword mode is simply the unconfigured default.

#### Scenario: Keyword default is stated, not warned

- **GIVEN** a repository using the keyword default
- **WHEN** the user runs `openlore analyze`
- **THEN** the active mode is stated once as `keyword`, with no degraded-fallback warning

#### Scenario: A configured-but-unreachable remote endpoint is surfaced

- **GIVEN** a configured remote embedding endpoint that is unreachable
- **WHEN** the index is built
- **THEN** a one-time notice states the configured endpoint failed and that keyword mode is in use
