# analyzer spec delta

## ADDED Requirements

### Requirement: AnalyzeCostScalesWithTheDiff

Batch analyze SHALL persist each file's Pass 1 extraction facts keyed by the file's content hash
and an extractor version stamp, and on a subsequent run SHALL re-extract only files whose key is
absent or changed, reusing cached facts for the rest; deleted files' facts SHALL be dropped.
Global (cross-file) passes SHALL run over the merged fact set unchanged. The reused lane SHALL
produce artifacts byte-identical to a `--force` full re-extraction of the same working tree. A
stamp or schema change SHALL invalidate the entire fact cache; `--force` SHALL bypass and then
repopulate it. The analyze summary SHALL disclose the counts of re-extracted vs reused files —
the lane is never silent.

#### Scenario: A one-file edit re-extracts one file

- **GIVEN** an analyzed repository with a populated fact cache
- **WHEN** one file is edited and `openlore analyze` runs
- **THEN** exactly that file is re-extracted (plus none others), the summary discloses
  `re-extracted 1, reused N−1`, and the resulting artifacts are byte-identical to
  `analyze --force` on the same tree

#### Scenario: A stamp bump never reuses stale facts

- **GIVEN** a fact cache written by extractor stamp v1
- **WHEN** analyze runs with extractor stamp v2
- **THEN** no v1 fact is reused, every file re-extracts, and the cache is repopulated under v2

#### Scenario: The stamp is derived from evidence, not declared by hand

- **GIVEN** the extractor version stamp
- **THEN** it is computed from a digest of the extraction code on disk plus the installed
  grammar package versions (including a grammar's ABSENCE), so an extractor edit or a grammar
  change invalidates the cache with no constant to remember, and the covered code roots are
  themselves verified against the extraction entry point's real import closure

#### Scenario: A deleted file leaves no ghost facts

- **GIVEN** a cached file that is deleted from the working tree
- **WHEN** analyze runs
- **THEN** its nodes, edges, and CFG entries are absent from the merged graph and its cache
  rows are removed
