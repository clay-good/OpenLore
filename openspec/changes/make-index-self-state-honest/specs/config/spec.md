# Spec Delta

## MODIFIED Requirements

### Requirement: KeywordIndexIsAFirstClassDefaultNotADegradedFallback

A keyword (BM25) search index SHALL be a first-class, supported retrieval mode and the default when no
embedding provider is configured. The absence of embeddings SHALL NOT be treated as an error or a
degraded fallback in configuration or messaging: structural correctness (the deterministic call graph,
blast radius, and drift) and lexical retrieval SHALL never depend on embeddings being present. The
configuration SHALL make embeddings an optional ranking upgrade, not a prerequisite for a working
index.

An *unconfigured* keyword index and a *configured but unrealized* semantic index SHALL be
distinguished wherever the system reports its retrieval state. The first is the default and SHALL NOT
be reported as a problem. The second — a resolvable embedding provider whose vectors are absent from
the index — SHALL be reported as a finding naming the unrealized expectation and its remedy, because
the operator asked for something that did not happen. This distinction SHALL NOT reframe the keyword
index itself as degraded in either case.

> Implemented by `make-embeddings-zero-config` (2026-06-23). Provider selection is centralised in
> `src/core/analyzer/embedder.ts` (`resolveEmbedder`); a null result is the keyword default, never an
> error. `VectorIndex`/`SpecVectorIndex` are typed to the `Embedder` interface and the BM25-only path
> (`hasEmbeddings:false` + `_bm25Only`) is reported as the named `keyword` mode.

#### Scenario: A repository with no embedding configuration has a fully working index

- **GIVEN** a repository with no `embedding` configuration and no `EMBED_*` environment variables
- **WHEN** the index is built
- **THEN** a first-class keyword index is produced and structural and lexical queries work, with no
  error and no degraded-fallback framing

#### Scenario: A configured provider whose vectors are absent is a finding

- **GIVEN** a repository whose `embedding` configuration or `EMBED_*` environment resolves a provider
- **AND** an index that carries no vectors
- **WHEN** the system reports its retrieval state
- **THEN** a finding states that the configured provider is unrealized in the current index and names
  the remedy, while the keyword results themselves are still described as a first-class mode

#### Scenario: The two causes are never conflated

- **GIVEN** two repositories serving keyword results — one with no provider configured, one with a
  configured provider whose vectors are absent
- **WHEN** each reports its retrieval state
- **THEN** the reported cause differs, and only the second carries a finding
