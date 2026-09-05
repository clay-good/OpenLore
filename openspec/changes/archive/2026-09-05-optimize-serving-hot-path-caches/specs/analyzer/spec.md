# analyzer spec delta

## ADDED Requirements

### Requirement: KeywordSearchDoesNotScanTheWholeCorpusPerQuery

The BM25 keyword search path (the default, zero-embedding search) SHALL score only the documents
a query term can actually match, rather than every document in the corpus; SHALL patch
document-frequency and length statistics incrementally on an update rather than re-tokenizing the
whole corpus; SHALL carry its query-side lookup structures across such an update rather than
rebuilding them; and SHALL NOT retain the unused embedding vector column in its in-memory cache.

The bound is the MATCH COUNT, not a top-k cap: a term present in most documents still yields most
documents as candidates. What the requirement forbids is paying for documents the query cannot
reach.

#### Scenario: A keyword search is bounded by what the query matches, not by corpus size

- **GIVEN** a large repository indexed for keyword (BM25) search
- **WHEN** a search runs for a term that a few documents contain
- **THEN** only those documents are scored, whatever the size of the corpus, and an incremental
  update patches the corpus statistics — and carries the lookup structures forward — without a
  full re-tokenization or a full rebuild
