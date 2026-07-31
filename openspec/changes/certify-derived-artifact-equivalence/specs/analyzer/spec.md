# analyzer spec delta

## ADDED Requirements

### Requirement: DerivedArtifactsAreDisposableAndAnswerEquivalent

Repository bytes and git history SHALL be the only source of truth. Every persisted derived
artifact — the structural graph store, the extracted-fact memo, the reachability precompute, the
vector tables, the keyword corpus sidecar, and an imported graph bundle — SHALL be a rebuildable
derived structure. Deleting a derived artifact, or encountering one that is corrupt or of an
outdated format, SHALL cost latency only and SHALL NOT change any answer the system serves.

Every path that exists to make the system faster SHALL be answer-equivalent to the authoritative
path it accelerates. The system SHALL maintain a standing equivalence suite asserting byte-identity
of served answers across at minimum: a cold build against a warm store; every serving path with
caching enabled against the same path with caching disabled; a parallel build at any worker count
against a single-worker build; an incremental update after an edit against a full rebuild of the
edited state; an imported graph bundle against a local analysis of the same commit; and a fact
served from the memo against the same fact recomputed from bytes.

A new acceleration path SHALL add its equivalence assertion to that suite as part of landing. The
suite SHALL compare the answers the system serves, not internal representations, so that a
representational change that preserves answers does not fail it and an answer change cannot pass it.

Every derived artifact SHALL be keyed on a hash of the inputs that produced it. Where a hash is
impractical and a stat-based or event-based freshness signal is used instead, the class of change
that signal cannot detect SHALL be named in that artifact's disclosure, and a full-verification
path SHALL exist that closes it on demand. An undisclosed staleness signal SHALL NOT be used.

#### Scenario: Deleting the derived index costs latency, not correctness

- **GIVEN** a repository with a fully built derived index and a recorded set of answers
- **WHEN** every derived artifact is deleted and the same questions are asked again
- **THEN** the answers are byte-identical to the recorded set

#### Scenario: A corrupt artifact never degrades an answer

- **GIVEN** a derived artifact that is corrupt or of an outdated format
- **WHEN** the system serves a query that would have read it
- **THEN** the artifact is rebuilt or set aside and the served answer is identical to the answer
  from a healthy artifact

#### Scenario: Worker count does not change the graph

- **GIVEN** a repository analyzed with a single extraction worker
- **WHEN** the same repository is analyzed with several workers
- **THEN** the served answers are byte-identical between the two builds

#### Scenario: An incremental update matches a full rebuild

- **GIVEN** an analyzed repository and an edit to one file
- **WHEN** the incremental path updates the index and a full rebuild is performed separately from
  the same post-edit state
- **THEN** the answers served from each are byte-identical

#### Scenario: Disabling the cache changes nothing but speed

- **GIVEN** any serving path that reuses a cached derived structure
- **WHEN** the same query runs with that reuse disabled
- **THEN** the served bytes are identical

#### Scenario: A new acceleration path arrives with its assertion

- **GIVEN** a change that introduces a new cache, precompute, or parallel path
- **WHEN** it is reviewed
- **THEN** the equivalence suite contains an assertion covering it
- **AND** the change is not complete without one

#### Scenario: A non-hash freshness signal names what it cannot see

- **GIVEN** a derived artifact whose freshness is tracked by file metadata rather than a content
  hash
- **WHEN** its disclosure is read
- **THEN** it names the change shape that metadata cannot detect
- **AND** a full-verification path exists that detects that shape on demand
