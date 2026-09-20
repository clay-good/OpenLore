# Spec Delta

## ADDED Requirements

### Requirement: StaleFilesAreOverlaidFromSourceAtQueryTime

When a query is served against an index that is behind the working tree for a known set of files,
the system SHALL re-extract those files from source and reconcile the symbol answer before
returning it. The overlay SHALL cover symbols, signatures, and spans of the stale files.

The overlay SHALL cache extraction by source path, language, and content hash, so a file already
extracted with the same bytes in this session is served from cache without assigning its nodes to
another file that happens to contain identical text.

#### Scenario: An edited symbol is served from source, not from the index

- **GIVEN** an indexed repository and a file edited since the index was built, adding a function
- **WHEN** a query that would return symbols from that file is served
- **THEN** the added function is present in the answer, carrying overlay provenance and no score,
  so it is distinguishable from a result the ranker placed

#### Scenario: A deleted symbol does not come back

- **GIVEN** a file whose indexed function has been deleted in the working tree
- **WHEN** a query is served
- **THEN** the deleted function is absent from the answer

#### Scenario: A new symbol is found when the index has no hits

- **GIVEN** a Git working tree with a new source file containing a symbol absent from the index
- **WHEN** a symbol query names that symbol
- **THEN** the bounded working-tree overlay returns it with source provenance and no rank score

#### Scenario: Unchanged files are not re-extracted

- **GIVEN** a repository with one stale file among many
- **WHEN** the overlay runs
- **THEN** only that file is re-extracted, and a second query in the same session re-parses nothing

### Requirement: TheOverlayIsBoundedAndFailsSoft

The overlay SHALL be bounded by an explicit cap on the number of stale files, the bytes re-extracted,
and the time spent. When a bound is exceeded, the system SHALL answer from the index and disclose the
staleness exactly as it does today — it SHALL NOT block the query, and it SHALL NOT partially apply
an overlay without saying so.

#### Scenario: A large stale set falls back to the disclosure

- **GIVEN** a working tree whose stale set exceeds the file cap
- **WHEN** a query is served
- **THEN** the answer comes from the index with the staleness disclosure, and states that the overlay
  was skipped for exceeding its bound

#### Scenario: A partial overlay names what it covered

- **GIVEN** a stale set where some files were overlaid before the time budget elapsed
- **WHEN** the answer is produced
- **THEN** it names the files the overlay covered and the files still served from the index

#### Scenario: An unparsable dirty file does not fail the query

- **GIVEN** a stale file whose current contents do not parse
- **WHEN** the overlay runs
- **THEN** the query is answered, that file is reported as not overlaid, and no error is raised

### Requirement: OverlaidFactsCarryTheirOwnProvenance

A fact served from the live overlay SHALL be distinguishable from a fact served from the index, and
the answer's completeness flag SHALL reflect what the overlay could not cover. In particular, call
edges into an overlaid symbol from files outside the stale set remain as the index recorded them;
this limit SHALL be disclosed rather than implied.

#### Scenario: An overlaid result is labelled

- **GIVEN** a query whose answer includes a symbol re-extracted by the overlay
- **WHEN** the answer is produced
- **THEN** that result carries overlay provenance, distinct from indexed provenance

#### Scenario: Edge staleness is disclosed, not hidden

- **GIVEN** an overlaid symbol whose callers live in files outside the stale set
- **WHEN** callers are reported
- **THEN** the answer states that incoming edges come from the index and may predate the edit
