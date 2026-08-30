# analyzer spec delta

## ADDED Requirements

### Requirement: FilteredSearchRecallIsHonest

Search filters (`language`, `minFanIn` on code search; `domain`, `section` on spec search) SHALL
be applied as database prefilters on the recall query, or the fetch SHALL be widened until the
filtered set fills the requested limit or the table is exhausted. A filtered query SHALL NOT
return fewer results than the limit while matching rows exist in the index without disclosing
that the filter constrained recall. Prefilter predicates SHALL use the established
backtick-quoted column discipline.

#### Scenario: A filtered query finds rows below the old fetch horizon

- **GIVEN** an index where the top ANN candidates are all TypeScript but matching Rust rows exist
  further down
- **WHEN** the user searches with `language: "rust"` and limit 10
- **THEN** the Rust rows are returned (prefilter or widened fetch), not an empty result

#### Scenario: Constrained recall is disclosed

- **GIVEN** a filtered query whose matching rows genuinely number fewer than the limit
- **WHEN** results are served
- **THEN** the response distinguishes "few matches exist" from "the filter constrained recall",
  never leaving a short result set unexplained

### Requirement: SearchIndexMaintenanceAndSpecFreshness

The watcher SHALL periodically compact the LanceDB tables it mutates (on an idle or
every-N-batches cadence, and after large deletions), so a long-lived session's query latency and
disk footprint do not grow without bound. The spec index SHALL NOT be silently staler than the
code index: spec-file edits under watch SHALL either update the specs table incrementally (or via
a scoped rebuild), or `search_specs` SHALL disclose the index's `builtAt` and the number of spec
files changed since.

#### Scenario: Fragments are compacted

- **GIVEN** a long-lived watch session that has processed many incremental batches
- **WHEN** the compaction cadence fires
- **THEN** the table is optimized and query results are unchanged before and after

#### Scenario: A spec edit is not silently invisible

- **GIVEN** a running watcher and an edit to `openspec/specs/<domain>/spec.md`
- **WHEN** the user calls `search_specs`
- **THEN** the result reflects the edit, or carries a disclosure naming the index's build time and
  the count of spec files changed since
