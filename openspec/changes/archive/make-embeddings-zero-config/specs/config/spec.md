# config spec delta

## ADDED Requirements

### Requirement: KeywordIndexIsAFirstClassDefaultNotADegradedFallback

A keyword (BM25) search index SHALL be a first-class, supported retrieval mode and the default when no
embedding provider is configured. The absence of embeddings SHALL NOT be treated as an error or a
degraded fallback in configuration or messaging: structural correctness (the deterministic call graph,
blast radius, and drift) and lexical retrieval SHALL never depend on embeddings being present. The
configuration SHALL make embeddings an optional ranking upgrade, not a prerequisite for a working
index.

#### Scenario: A repository with no embedding configuration has a fully working index

- **GIVEN** a repository with no `embedding` configuration and no `EMBED_*` environment variables
- **WHEN** the index is built
- **THEN** a first-class keyword index is produced and structural and lexical queries work, with no
  error and no degraded-fallback framing

### Requirement: LocalEmbedderIsAZeroConfigOptInUpgrade

The configuration SHALL support an opt-in local embedding provider that requires no external endpoint
and no API key, selectable via the existing `embedding` block (for example `embedding.provider:
"local"`). When selected, embeddings SHALL be produced on-device from a pinned, pre-trained model whose
weights are lazily downloaded and cached on first use. The existing remote OpenAI-compatible provider
(`embedding.baseUrl` / `embedding.model` / `embedding.apiKey` and the `EMBED_*` environment variables)
SHALL remain fully supported and unchanged. Both providers SHALL implement the same embedding contract
so the index is agnostic to the embedder source.

#### Scenario: Local provider needs neither endpoint nor key

- **GIVEN** a configuration selecting the local embedding provider
- **WHEN** the index is built
- **THEN** semantic embeddings are produced on-device, without any external endpoint or API key, using
  a cached local model

#### Scenario: Remote provider still works unchanged

- **GIVEN** a configuration with `embedding.baseUrl` and `embedding.model` set (or the `EMBED_*`
  environment variables)
- **WHEN** the index is built
- **THEN** embeddings are produced via the remote OpenAI-compatible endpoint exactly as before
