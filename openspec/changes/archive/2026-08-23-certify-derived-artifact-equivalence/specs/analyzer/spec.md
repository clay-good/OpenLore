# analyzer spec delta

## ADDED Requirements

### Requirement: DerivedArtifactsAreDisposableAndAnswerEquivalent

The authoritative input SHALL be the tuple `(repository snapshot, reachable git history,
normalized analysis configuration, registered analyzer capabilities)`. The repository snapshot
SHALL contain the ordered normalized relative paths and bytes selected for analysis; history SHALL
be the object graph reachable from the selected revision; configuration SHALL be validated and
default-expanded; and capabilities SHALL identify the registered parser/extractor versions
available to the run. Every persisted derived artifact — the structural graph store, the
extracted-fact memo, the reachability precompute, the vector tables, the keyword corpus sidecar,
and an imported graph bundle — SHALL be a rebuildable derived structure. An absent, corrupt, or
outdated optional accelerator SHALL fall back or rebuild without changing the semantic answer. An
unavailable authoritative analysis store SHALL fail closed with deterministic remediation and
SHALL NOT serve a partial or guessed semantic answer; after the explicit repair barrier completes,
its semantic answer SHALL equal a fresh analysis of the same authoritative input tuple.

Every registered path that exists to make the system faster SHALL be semantically answer-equivalent
to the authoritative path it accelerates for the same authoritative input tuple. The standing
suite SHALL maintain the finite registered rows `cold-warm-context`, `memo-hit-miss`,
`parallel-serial-extraction`, `precomputed-live-traversal`, `incremental-full-repair`,
`imported-local-structural`, `bm25-cached-uncached`, `function-vector-repair`, and
`spec-vector-repair`. Each row SHALL declare its fixtures, operating modes, and the authoritative
input tuple fields it binds. The contract SHALL NOT imply
coverage of unregistered worker counts, cache modes, queries, or serving paths.

A new acceleration path SHALL add a registered row to that suite as part of landing. The suite
SHALL compare the versioned `semantic-answer-v1` projection, consisting of canonicalized stable
structural facts and conclusion payloads. Version 1 SHALL exclude only the registered operational
fields `cached`, `cacheState`, `freshness`, `freshnessLease`, `generatedAt`, `generationId`,
`repair`, `repairStatus`, `servedAt`, and `timing`. Those operational disclosures SHALL be asserted
separately and SHALL NOT be removed to make equality pass. Filesystem locations, receipts, and any
unregistered field remain semantic evidence. Any change to projection membership or normalization
SHALL introduce a reviewed projection version and corresponding fixtures.

The incremental watcher row SHALL compare the incremental state only after the documented repair
barrier reports convergence. It SHALL separately assert the stale/repair disclosure visible during
an in-flight repair. The imported row SHALL accept only a supported bundle whose payload digest,
producer trust, and source binding have passed validation, and SHALL compare only the structural
payload guaranteed by that bundle format. Machine-local dense indexes and optional enrichment SHALL
be rebuilt locally and SHALL NOT be treated as imported-parity fields.

Every derived artifact SHALL be keyed on a hash of the inputs that produced it. Where a hash is
impractical and a stat-based or event-based freshness signal is used instead, the class of change
that signal cannot detect SHALL be named in that artifact's disclosure, and a full-verification
path SHALL exist that closes it on demand. An undisclosed staleness signal SHALL NOT be used.

#### Scenario: Deleting an optional accelerator costs latency, not correctness

- **GIVEN** a repository with a healthy optional accelerator and a recorded semantic answer
- **WHEN** that accelerator is deleted and the same question is asked again
- **THEN** fallback or rebuild produces a byte-identical semantic projection

#### Scenario: An unavailable authoritative store fails closed until repaired

- **GIVEN** an authoritative analysis store that is absent, corrupt, or of an outdated format
- **WHEN** a query requires that store before repair completes
- **THEN** the system returns deterministic unavailability and repair guidance, not a partial answer
- **AND** after the repair barrier completes, the semantic projection is byte-identical to a fresh
  analysis of the same authoritative input tuple

#### Scenario: Worker count does not change the graph

- **GIVEN** a repository analyzed with a single extraction worker
- **WHEN** the same repository is analyzed with several workers
- **THEN** the served answers are byte-identical between the two builds

#### Scenario: An incremental update matches a full rebuild

- **GIVEN** an analyzed repository and an edit to one file
- **WHEN** the incremental path reaches its documented post-repair convergence barrier and a full
  rebuild is performed separately from the same post-edit state
- **THEN** the answers served from each are byte-identical
- **AND** any stale or repair disclosure observed before convergence was separately asserted

#### Scenario: Disabling the cache changes nothing but speed

- **GIVEN** any serving path that reuses a cached derived structure
- **WHEN** the same query runs with that reuse disabled
- **THEN** the served bytes are identical

#### Scenario: A trusted structural bundle matches local structure

- **GIVEN** a supported bundle with valid integrity, trusted producer provenance, and source binding
- **WHEN** its guaranteed structural payload and a local analysis of the same authoritative input
  tuple are projected through `semantic-answer-v1`
- **THEN** those structural projections are byte-identical
- **AND** locally rebuilt dense indexes and optional enrichments are not claimed as imported fields

#### Scenario: A new acceleration path arrives with its assertion

- **GIVEN** a change that introduces a new cache, precompute, or parallel path
- **WHEN** it is reviewed
- **THEN** the equivalence suite contains an assertion covering it
- **AND** the change is not complete without one

#### Scenario: Operational disclosure is not normalized away

- **GIVEN** two equivalent semantic answers produced through different recovery modes
- **WHEN** `semantic-answer-v1` equality is checked
- **THEN** their stable structural facts and conclusions compare equal
- **AND** separate assertions preserve and verify each rebuild, quarantine, repair, or rejection
  disclosure

#### Scenario: A non-hash freshness signal names what it cannot see

- **GIVEN** a derived artifact whose freshness is tracked by file metadata rather than a content
  hash
- **WHEN** its disclosure is read
- **THEN** it names the change shape that metadata cannot detect
- **AND** a full-verification path exists that detects that shape on demand
