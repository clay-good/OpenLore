# mcp-handlers spec delta

## ADDED Requirements

### Requirement: SymbolSpanLocatorReportsFreshnessVerdict

The `locate_symbol_span` tool SHALL be read-only (`readOnlyHint: true`) and SHALL NOT write, move,
or delete any file. It SHALL resolve its target through the same `name::path` addressing used by
`find_clones` and SHALL refuse to guess: an unknown symbol returns `not-found` with candidates; an
ambiguous bare name returns `ambiguous` with the `name::path` candidate list. For a resolved
symbol it SHALL return the byte-exact and line span plus a freshness verdict derived from comparing
the indexed span's content hash against the file's current bytes: `fresh` when they match (the span
is safe to edit at exactly these offsets), or `stale` with a re-analyze hint and no usable offset
when they differ (the index is behind the working tree). The tool SHALL NOT itself apply an edit —
it hands the host a location the substrate can vouch for; the host applies the write with its own
tool.

#### Scenario: An ambiguous symbol returns candidates, not a location

- **GIVEN** two indexed functions named `process` in different files and a call targeting bare
  `process`
- **WHEN** `locate_symbol_span` runs
- **THEN** the verdict is `ambiguous` and both `process::<path>` candidates are listed
- **AND** no span is returned

#### Scenario: A stale span is disclosed, never served as trustworthy

- **GIVEN** a symbol whose file changed after the last analysis (indexed span hash ≠ current
  content)
- **WHEN** `locate_symbol_span` targets it
- **THEN** the verdict is `stale` with a re-analyze hint
- **AND** no usable offset is presented as current

#### Scenario: A fresh span returns the byte-exact edit location

- **GIVEN** an unambiguous `name::path` symbol whose span hash matches current content
- **WHEN** `locate_symbol_span` runs
- **THEN** the verdict is `fresh` and the result carries the byte and line span plus the content
  hash
- **AND** no file is modified (the host performs any edit)
