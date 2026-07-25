# architecture spec delta

## ADDED Requirements

### Requirement: FirstRunServesPartialWithACompletenessReceipt

During an index-absent first build on the interactive/daemon path, the pipeline SHALL flush
partial artifacts periodically (atomic writes, analysis-lock held), each stamped
`{filesExtracted, filesTotal, phase, partial: true}`, and reads SHALL be served from the newest
partial artifact with the completeness receipt disclosed through the epistemic lease. Because
input is significance-ordered, early flushes SHALL contain the highest-value files first.
Negative conclusions that partiality can invert (dead-code candidates, coverage gaps,
"no callers") SHALL be withheld or explicitly downgraded while partial. A partial artifact
SHALL never be exported, bundled, attested, or imported. The completed build's output SHALL be
byte-identical to a single-write build of the same tree, and completion SHALL clear the partial
state.

#### Scenario: Orient answers seconds into a first build, honestly

- **GIVEN** a fresh install on a large repo, 30 seconds into the background first build
- **WHEN** the agent calls `orient`
- **THEN** it receives results from the flushed hub-first partial graph, with the lease
  disclosing "index N% complete" and the unindexed remainder named as invisible-not-absent

#### Scenario: Partiality never fabricates a negative

- **GIVEN** a partial index missing the file that contains a symbol's only caller
- **WHEN** a dead-code or no-reaching-test conclusion would name that symbol
- **THEN** the conclusion is withheld or downgraded with the partial boundary cited — never
  served as an authoritative negative

#### Scenario: Completion converges to the single-write output

- **GIVEN** a first build that flushed partial artifacts
- **WHEN** the build completes
- **THEN** the final artifacts are byte-identical to a non-flushing build of the same tree and
  no `partial` stamp remains
