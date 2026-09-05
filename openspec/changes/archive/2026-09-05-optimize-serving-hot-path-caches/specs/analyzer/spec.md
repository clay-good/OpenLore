# analyzer spec delta

## ADDED Requirements

### Requirement: KeywordSearchDoesNotScanTheWholeCorpusPerQuery

The BM25 keyword search path (the default, zero-embedding search) SHALL NOT scale its per-query
work with total corpus size beyond returning the top-k results, SHALL patch document-frequency
and length statistics incrementally on an update rather than re-tokenizing the whole corpus, and
SHALL NOT retain the unused embedding vector column in its in-memory cache.

#### Scenario: A keyword search is bounded by top-k, not corpus size

- **GIVEN** a large repository indexed for keyword (BM25) search
- **WHEN** a search runs
- **THEN** its cost is bounded to producing the top-k matches, and an incremental update patches
  the corpus statistics without a full re-tokenization
