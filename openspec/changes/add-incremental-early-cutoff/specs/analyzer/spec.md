# analyzer spec delta

## ADDED Requirements

### Requirement: ExtractionFactEarlyCutoff

The incremental update SHALL compute a deterministic digest of each changed file's extracted facts
with byte positions left out, and SHALL stop propagation when the digest equals the stored digest
for that file: the file's own records are updated, no dependent file is parsed again, and no file
is marked stale. The comparison SHALL use extracted facts only, never modification times. The
digest SHALL carry a version stamp, and digests with different stamps SHALL NOT be compared. When
the digests differ, behavior SHALL be the same as before this change.

#### Scenario: A comment-only edit costs one parse

- **WHEN** an indexed file with callers in other files is edited to change only comments and formatting
- **THEN** that file is parsed once, no caller file is parsed, and no file is marked stale
- **AND** the graph equals the graph `analyze --force` produces

#### Scenario: The file's own positions stay exact

- **WHEN** a cut-off edit inserts a comment block at the top of a file
- **THEN** each symbol's stored line range matches the current source

#### Scenario: A structural change propagates as today

- **WHEN** an edit changes a signature, or adds or removes a symbol, call, or import
- **THEN** the digests differ and the existing closure, work budget, and stale marks apply unchanged

#### Scenario: A version change never compares old digests

- **WHEN** the analyzer runs with a digest version that differs from the stored one
- **THEN** every stored digest is discarded and no file cuts off on it
