# architecture spec delta

## ADDED Requirements

### Requirement: FirstRunServesPartialWithACompletenessReceipt

During an index-absent first build on the interactive/daemon path, the pipeline SHALL flush a
partial index once the repository structure and dependency graph exist, and SHALL keep its
receipt current while the build runs. The flush SHALL be atomic, SHALL publish its own
content-digest commit before its receipt, and SHALL be stamped
`{filesExtracted, filesTotal, phase, partial: true}`.

A partial index SHALL NOT be an analysis artifact: it SHALL be written outside the analysis
directory, and SHALL therefore never enter the published generation, the fingerprint, or the
build attestation. It SHALL never be exported, bundled, attested, or imported. It SHALL be read
as untrusted repository content — bounded, refusing symlinks and non-regular files — and any
call-graph-shaped field found in one SHALL be discarded rather than served.

Reads during the build SHALL adopt the stale case's serving contract rather than the
index-absent dead end. A read whose facts the partial index holds SHALL be answered from it. A
read that cannot be answered at all SHALL disclose the running build instead of directing the
caller to start one. Every such response SHALL carry a receipt naming what the index holds, what
it does not yet hold, and that facts it has not reached are invisible to the answer rather than
absent from the repository. The receipt SHALL be attached where all transports meet, so an
answer cannot lose it by being served over one front end rather than another.

Negative conclusions that partiality can invert — dead-code candidates, coverage gaps, "no
callers" — SHALL be withheld while partial, citing the boundary. A partial index whose owning
build is gone, whose receipt has stopped being refreshed, or whose receipt is dated in the
future SHALL be ignored.

The completed build's output SHALL be byte-identical to a single-write build of the same tree,
and completion SHALL remove the partial index.

#### Scenario: A tool call during a first build is answered, not deflected

- **GIVEN** a fresh install on a large repository whose first build is still running
- **WHEN** an agent asks for the architecture overview
- **THEN** it receives the real cluster, file, and edge counts computed from the flushed
  dependency graph, together with a receipt naming the call graph and search index as not yet
  built — never a zeroed answer, and never "no analysis found; run openlore analyze"

#### Scenario: A tool that still cannot answer says why

- **GIVEN** the same build, and a tool that needs the call graph
- **WHEN** the agent calls it
- **THEN** it is told the first analysis is running and what the index already holds, rather
  than being directed to start the build that is already running

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
