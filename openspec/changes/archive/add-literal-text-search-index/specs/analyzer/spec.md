# analyzer spec delta

## ADDED Requirements

### Requirement: LiteralTextLineIndex

The system SHALL maintain a literal-text line index separate from the symbol (call-graph / signature)
index. The text index SHALL store raw lines of walked files whose content is not represented as
extracted symbols — markup, stylesheet, template, and plain-text files — keyed by file path and line
number, holding the line text. The index SHALL be BM25-only (lexical), with no vector embeddings, and
SHALL be queryable by exact-lexical match. Lines that are blank or whitespace-only SHALL be skipped;
over-long lines SHALL be truncated, not dropped.

#### Scenario: A static markup string is indexed

- **GIVEN** an `index.html` containing the static text `Message completed`
- **WHEN** the analysis builds its indexes
- **THEN** the literal-text line index contains a row for that line with its file path and line number

#### Scenario: Text lines are not graph nodes

- **GIVEN** the literal-text line index is populated
- **WHEN** the call graph and its node-level metrics (fanIn, fanOut, hubs, entrypoints, communities,
  PageRank) are computed
- **THEN** no text line appears as a node and no text line contributes to any node-level metric

### Requirement: LiteralTextLineIndexIncrementalUpdate

The literal-text line index SHALL be updated incrementally when watched files change. On a changed or
added text file the index SHALL replace that file's lines; on a deleted file the index SHALL remove that
file's lines. The symbol index's incremental update SHALL be unaffected.

#### Scenario: Editing a text file updates its lines

- **GIVEN** an indexed text file
- **WHEN** the file is edited and the watcher processes the change
- **THEN** the text index reflects the new lines and no stale lines for that file remain
