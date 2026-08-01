# analyzer spec delta

## ADDED Requirements

### Requirement: ParseHealthIsRecordedAndDisclosed

The analyzer SHALL record a per-file parse-health record during extraction for any file whose parse
is degraded: the count and line spans of tree-sitter ERROR / MISSING nodes, an outright parse
failure, or a lossy (encoding-fallback) decode. The record SHALL be tallied in the same per-file
AST walk that extracts nodes and edges (no second parse). A per-file extraction failure SHALL
produce a structured parse-health record — never a silently discarded error — while remaining
fail-soft (one bad file never aborts the build). Records SHALL be rolled up and persisted as their
own analysis artifact and maintained incrementally by the watcher (created when a change first
degrades a file, removed when the last degraded file is repaired). A clean file SHALL produce no
record and a clean repository SHALL write no artifact, so healthy repositories pay zero.

Parse health SHALL be a SOUND LOWER BOUND: a `hasError` signal with no confirmed ERROR/MISSING node
is dropped rather than fabricated, and grammars whose parser lifecycle makes `hasError` untrustworthy
(the shared-heap WASM grammars) are fail-soft — not tallied — so a parse-health record is never a
false positive. Which grammars are excluded is a disclosed property of the loader, not a guess.

The conformance suite SHALL assert that its own native-grammar fixtures parse with zero ERROR/MISSING
nodes, so a grammar upgrade that degrades extraction fails CI rather than silently shrinking graphs
in the field.

#### Scenario: A file with a syntax error yields a lower-bound disclosure, not a silent gap

- **GIVEN** a supported-language file containing a syntax error the grammar cannot recover cleanly
- **WHEN** `analyze` runs
- **THEN** symbols outside the ERROR region are still extracted
- **AND** the file's parse-health record reports the ERROR region count and spans

#### Scenario: A lossy decode is disclosed, not omitted

- **GIVEN** a file whose UTF-8 decode was lossy (contained the U+FFFD replacement character)
- **WHEN** `analyze` runs
- **THEN** the parse-health record marks the encoding fallback
- **AND** no conclusion presents that file's absence of symbols as verified emptiness

#### Scenario: Grammar drift fails the conformance canary

- **GIVEN** a tree-sitter grammar upgrade that makes a native-grammar fixture parse with ERROR/MISSING nodes
- **WHEN** the conformance suite parses its fixtures
- **THEN** the resulting parse-health record fails the suite

#### Scenario: A clean repository records nothing

- **GIVEN** a repository whose files all parse cleanly
- **WHEN** `analyze` runs
- **THEN** no parse-health artifact is written
