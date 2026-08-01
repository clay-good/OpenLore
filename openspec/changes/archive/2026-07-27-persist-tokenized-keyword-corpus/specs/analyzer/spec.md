# analyzer spec delta

## ADDED Requirements

### Requirement: PersistedKeywordCorpusGuardedByTokenizerStamp

The keyword (BM25) corpus for the function index SHALL be persisted to a sidecar artifact stamped
with the tokenizer version that produced it. On load, a sidecar whose stamp equals the running
`TOKENIZER_VERSION` SHALL hydrate the corpus without re-tokenizing any document; a missing, corrupt,
or version-mismatched sidecar SHALL cause the corpus to be rebuilt from the persisted raw text under
the current tokenizer and re-persisted. A persisted corpus SHALL NEVER be served when its tokenizer
version does not match `TOKENIZER_VERSION`. An incremental update that mutates the index SHALL
invalidate the sidecar so a subsequent load does not hydrate a corpus that predates the update.
Persistence SHALL be deterministic, introduce no new tuning constants, and reuse the existing
`TOKENIZER_VERSION`; a separate corpus schema-version stamp MAY version the serialization format.
Fallback to rebuilding from raw text SHALL NEVER surface as a hard failure.

#### Scenario: Cold start hydrates from the sidecar without re-tokenizing

- **GIVEN** a persisted keyword corpus whose tokenizer stamp equals `TOKENIZER_VERSION`
- **WHEN** the first keyword query runs in a fresh process (empty in-memory corpus cache)
- **THEN** the corpus is loaded from the sidecar and no document is re-tokenized, and the query
  returns the same results as a corpus built directly from the same rows

#### Scenario: A tokenizer-version mismatch rebuilds, never serves mixed

- **GIVEN** a sidecar written under an older tokenizer version
- **WHEN** a keyword query runs under a newer `TOKENIZER_VERSION`
- **THEN** the sidecar is ignored, the corpus is rebuilt from raw text under the current tokenizer,
  results are never served from the stale sidecar, and the sidecar is re-stamped to the current
  version

#### Scenario: A missing or corrupt sidecar degrades, never fails

- **GIVEN** a legacy index with no sidecar, or a sidecar that does not parse
- **WHEN** a keyword query runs
- **THEN** the corpus is rebuilt from the persisted raw text (the pre-change behavior) with no hard
  failure, and the sidecar is (re)written for the next process

#### Scenario: An incremental update invalidates the persisted corpus

- **GIVEN** a persisted keyword corpus
- **WHEN** an incremental update patches the index for changed files
- **THEN** the sidecar is invalidated, so the next cold start rebuilds the corpus from raw text
  rather than hydrating one that predates the patch
