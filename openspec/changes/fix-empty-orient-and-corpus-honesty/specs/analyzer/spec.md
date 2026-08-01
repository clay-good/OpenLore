# analyzer spec delta

## ADDED Requirements

### Requirement: SearchableFunctionCorpusContainsOnlyRepoSymbols

The function search corpus (BM25 and vector) SHALL contain only symbols defined in the analyzed
repository. Synthetic call-target nodes (`external::` and any other placeholder namespace) SHALL
be excluded from the corpus and from corpus-derived counts. A search result SHALL always name a
file the user can open.

#### Scenario: An external callee is not a searchable function

- **GIVEN** a repository whose only reference to `startsWith` is a call into the JavaScript
  standard library (producing an `external::id.startsWith` call-graph node)
- **WHEN** the search index is built and queried for "startsWith"
- **THEN** the corpus contains no `external::` entry, the reported corpus size equals the
  repository's function count, and the query returns repo symbols only (or an honest empty
  result)
