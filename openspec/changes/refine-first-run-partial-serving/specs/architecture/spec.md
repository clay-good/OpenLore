# architecture spec delta

## ADDED Requirements

### Requirement: FirstRunServesPartialWithACompletenessReceipt

During an index-absent first build on the interactive/daemon path, the pipeline SHALL flush a
partial index at phase boundaries and keep its completeness receipt current while the build
runs. Each flush SHALL be atomic, SHALL publish its own content-digest commit, and SHALL be
stamped `{filesExtracted, filesTotal, phase, partial: true}`. Because input is
significance-ordered, the flushed structure SHALL cover the highest-value files first.

A partial index SHALL NOT be an analysis artifact: it SHALL be written outside the analysis
directory, and SHALL therefore never enter the published generation, the fingerprint, or the
build attestation. It SHALL never be exported, bundled, attested, or imported.

Reads during the build SHALL adopt the stale case's serving contract rather than the
index-absent dead end. A read answered from the partial index SHALL disclose its completeness,
name what the index has not yet built, and state that unreached files are invisible to the
answer rather than absent from the repository. A read that cannot be answered at all SHALL
disclose the running build's progress instead of directing the caller to start one.

Negative conclusions that partiality can invert — dead-code candidates, coverage gaps,
"no callers" — SHALL be withheld while partial, citing the boundary. A partial index SHALL be
ignored once its owning build is gone.

The completed build's output SHALL be byte-identical to a single-write build of the same tree,
and completion SHALL remove the partial index.

#### Scenario: A tool call during a first build is answered, not deflected

- **GIVEN** a fresh install on a large repository whose first build is still running
- **WHEN** an agent calls a tool
- **THEN** it is answered from the flushed partial index where the facts exist, and in either
  case the response discloses "index N% complete", names what has not been built yet, and says
  the build is running — never "no analysis found; run openlore analyze"

#### Scenario: Partiality never fabricates a negative

- **GIVEN** a partial index that has not reached the file containing a symbol's only caller
- **WHEN** a dead-code or no-reaching-test conclusion would name that symbol
- **THEN** the conclusion is withheld with the partial boundary cited — never served as an
  authoritative negative

#### Scenario: Completion converges to the single-write output

- **GIVEN** a first build that flushed a partial index
- **WHEN** the build completes
- **THEN** the published artifacts are byte-identical to a non-flushing build of the same tree
  and no partial index remains
