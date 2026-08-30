# mcp-handlers spec delta

## ADDED Requirements

### Requirement: SearchScoresAreSelfDescribing

Every search result served through `search_code` and `search_specs` SHALL carry a `scoreKind`
field naming the score's semantics and polarity (`rrf` and `bm25`: higher is more relevant;
`cosine_distance`: lower is more similar). A numeric relevance score SHALL NOT be served whose
meaning depends on the retrieval mode without that per-result disclosure — disclosure in a source
comment or a top-level `retrievalMode` field alone is not sufficient, because the polarity flip is
per-result-consumable information. Score normalization to a single higher-is-better scale is
permitted but optional; the self-describing field is the requirement.

#### Scenario: Spec search polarity is disclosed

- **GIVEN** a `search_specs` call under semantic mode (cosine distance) and the same call under
  BM25 keyword mode
- **WHEN** results are served
- **THEN** each result's `scoreKind` states which semantics its score carries, so a consumer never
  ranks distance ascending as if it were relevance descending

#### Scenario: No bare mode-dependent score

- **GIVEN** any code path that serves a search score (RRF merge, BM25, or a dense-distance branch)
- **WHEN** the result reaches a tool consumer
- **THEN** the score is accompanied by its `scoreKind`, including on branches that are latent today
