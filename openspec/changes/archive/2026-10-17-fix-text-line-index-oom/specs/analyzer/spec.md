# analyzer spec delta

## ADDED Requirements

### Requirement: TextLineIndexBuildIsStreamed

Building the text-line index SHALL NOT hold the repository's text, or the line records derived from
it, in memory all at once. The build SHALL accept its input as a stream and SHALL flush accumulated
records to storage at a bounded interval, so peak residency is a function of the flush interval
rather than of the repository.

Line records are an amplification of the source, not a summary of it: one object per non-blank
line, on top of the text they were extracted from. A build that materializes the whole corpus
before writing anything therefore exhausts the heap on a large repository even when every earlier
phase has succeeded.

#### Scenario: A large repository is indexed under a fixed heap

- **GIVEN** a repository with more source lines than fit in memory as line records
- **WHEN** the text-line index is built
- **THEN** the build completes, and peak memory tracks the flush interval rather than the number of
  lines in the repository

#### Scenario: Records from every batch are present

- **GIVEN** an input large enough to span several flushes
- **WHEN** the index is built
- **THEN** a line from the first batch, a line from a middle batch, and a line from the last batch
  are all findable — later flushes append rather than replace

### Requirement: StreamedBuildPreservesIndexIdentity

A streamed build SHALL produce the same index as an equivalent non-streamed build: the same rows,
in the same order, with the same counts. Input given as an async iterable and the same input given
as an array SHALL be indistinguishable in the resulting index.

Row order is a function of the input file order, never of read-completion timing.

#### Scenario: Streamed and array inputs agree

- **GIVEN** the same set of files supplied once as an array and once as an async iterable
- **WHEN** each is indexed
- **THEN** both report identical line and file counts, and a search returns the same file and line
  for the same query

### Requirement: EmptyCorpusLeavesNoIndex

A build that yields no indexable lines SHALL leave no table behind, and SHALL remove a previously
built index rather than leaving a stale one. Creating storage for an empty corpus is forbidden: a
table that exists but holds nothing is indistinguishable, to a reader, from an index that was never
built for a repository with nothing to index.

#### Scenario: Nothing indexable

- **GIVEN** a repository whose files contain only blank lines, or no files at all
- **WHEN** the text-line index is built
- **THEN** the build reports zero lines and zero files, and no index is left behind

#### Scenario: An index is rebuilt from an empty corpus

- **GIVEN** a previously built text-line index
- **WHEN** the index is rebuilt from a corpus with nothing indexable
- **THEN** the previous index is dropped and searches return nothing
