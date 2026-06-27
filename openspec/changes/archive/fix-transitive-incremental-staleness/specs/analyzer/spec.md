# analyzer spec delta

## ADDED Requirements

### Requirement: IncrementalUpdateConvergesToFullAnalyzeOrMarksStale

The incremental call-graph update path (the file watcher's per-batch update) SHALL, for the region
affected by a change, converge to the same graph that a full `analyze --force` would produce. It SHALL
re-parse and re-resolve the changed file's direct dependents — its direct callers AND prior non-callers
whose previously-`external` call sites a newly-added symbol should now bind — rather than re-parsing
only the changed file and a fixed-size slice of its direct callers. (Because a batch fully determines
the set of symbols it adds or removes, this single bounded expansion is sufficient to converge the
affected region; no multi-hop fixpoint iteration is required.) Where the update cannot complete that
expansion within a bounded work budget (`INCREMENTAL_CLOSURE_BUDGET`), it SHALL explicitly mark the
un-recomputed files as `stale` in the graph metadata; it SHALL NOT leave a divergent region unmarked. The update SHALL be sound: it MAY
mark more than the minimal dirty set as stale, but it SHALL NOT report a stale region as current.

#### Scenario: A direct-caller resolution change converges

- **GIVEN** a file `B` that directly calls a symbol in `C`, where editing `C` changes how `B` resolves
  that call
- **WHEN** the incremental watcher processes the save
- **THEN** the resulting graph over `B` and `C` equals the graph that `analyze --force` would produce
  for that region (`B`, a direct caller, is recomputed; callers of `B` that do not themselves call `C`
  are unaffected)

#### Scenario: A newly-introduced symbol is resolved by a prior non-caller

- **GIVEN** a file `X` with a previously-unresolved call that should now resolve to a symbol newly
  added in the changed file
- **WHEN** the incremental watcher processes the save
- **THEN** the new edge from `X` is present, matching the `analyze --force` result, even though `X`
  was not previously a caller of the changed file

#### Scenario: A hub change that exceeds the budget is flagged, not silently wrong

- **GIVEN** a change to a hub whose reverse-dependency closure exceeds the incremental work budget
- **WHEN** the incremental watcher processes the save
- **THEN** the un-recomputed region is explicitly marked `stale` in the graph metadata, and no part of
  that region is served as current

### Requirement: FreshnessVerdictsHonorTheStaleRegion

A freshness verdict over a symbol SHALL account for the staleness of the symbol's surrounding
topology, not only the symbol's own existence and content hash. A symbol that lies within an
explicitly-marked stale region SHALL NOT be reported as `fresh`/authoritative; it SHALL be reported as
`drifted` (or otherwise non-authoritative) until the region is reconciled. A downgrade caused ONLY by
the stale region (the anchored code is byte-identical) SHALL be distinguishable from a genuine content
change — it carries a `staleRegion` marker — so consumers can label it "not yet reconciled" rather than
asserting the code changed. In particular, the code-vs-memory drift detector SHALL NOT report a pure
stale-region downgrade as drift (it is not a code change and it self-heals).

#### Scenario: A memory anchored above a stale subgraph is not reported fresh

- **GIVEN** a memory anchored to `A`, where `A`'s file has been marked `stale` by a
  budget-exceeded incremental update
- **WHEN** the memory's freshness is evaluated
- **THEN** the verdict is not `fresh`; it reflects that `A`'s topology is stale, and it is marked as a
  stale-region downgrade (not a code change)

### Requirement: StaleRegionsAreReconciledWithoutAManualFullAnalyze

An explicitly-marked stale region SHALL be reconciled over time — opportunistically as later edits
touch it — so the stale region shrinks toward empty without requiring the user to run `analyze --force`
manually. A full `analyze --force` SHALL clear all stale markings and SHALL remain the authoritative
ground truth against which incremental convergence is defined and tested.

#### Scenario: A stale region clears without manual intervention

- **GIVEN** a region marked `stale` by a budget-exceeded incremental update
- **WHEN** subsequent edits touch parts of that region
- **THEN** the reconciled parts are recomputed to match `analyze --force` and dropped from the stale
  region, which shrinks toward empty
