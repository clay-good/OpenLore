# architecture spec delta

## ADDED Requirements

### Requirement: GraphIndexIntegrityAttestation

When an analysis completes and the structural graph index is persisted, the system SHALL compute and
store a deterministic **integrity attestation** alongside the index: the schema version, integer counts
of the primary artifacts extraction committed (distinct source files, functions, edges, classes), and a
content digest of the persisted graph. The counts SHALL be taken from the same population the load path
recounts (internal, non-test nodes), so a healthy index reconciles exactly. Files that fail to parse are
accounted for implicitly — they contribute no nodes, so the committed counts already reflect them — and
no fabricated parse-failure number is recorded (honesty over coverage). The attestation SHALL be a
deterministic function of the build — byte-identical across re-analyses of a fixed repository state —
computed without a clock, a model, or sampling. The attestation extends the system's existing "never
present absence as current fact" guarantee from the memory and decision stores to the structural graph
itself.

#### Scenario: A completed build writes a deterministic attestation

- **GIVEN** a repository that is analyzed to completion
- **WHEN** the graph index is persisted
- **THEN** an integrity attestation is written alongside it recording the schema version, committed
  file/function/edge/class counts, and a content digest, and re-analyzing the same commit produces a
  byte-identical attestation

### Requirement: IndexPlausibilityVerdict

The system SHALL derive a deterministic plausibility verdict for the persisted index — `healthy`,
`degraded`, or `mismatched` — by reconciling the persisted index against its attestation, NOT by
re-running extraction. `healthy` means the persisted production counts reconcile with what extraction
committed at the current schema version (an index that legitimately grew via incremental updates remains
healthy). `degraded` means the persisted graph is materially smaller than what extraction committed — the
persisted-to-committed ratio falls below a fixed, documented floor — after a checkpoint-and-recount retry,
i.e. the build did not fully land or the store was truncated. `mismatched` means the index was built at a
different schema version than the attestation records. The ratio floor SHALL be a fixed constant with a
small-repo exemption, since a tiny repo's counts are too small for a ratio to be meaningful.

The content digest SHALL be recorded for build-determinism and tamper-evidence but SHALL NOT drive the
load-time verdict: the incremental watcher legitimately mutates the persisted store between full builds,
so a digest-equality load check would false-positive on every incremental update. Schema version drives
`mismatched`; the count ratio drives `degraded`.

Reading the attestation SHALL fail closed: a malformed, truncated, foreign-version, or oversized
attestation (e.g. a `committed` record missing numeric counts) SHALL be treated as unverifiable
(no verdict), NEVER trusted — without this, an undefined count would make the ratio non-finite and the
`degraded` comparison `false`, silently fabricating a `healthy` verdict. The read SHALL bound the file
size, consistent with untrusted-artifact deserialization safety.

The incremental watcher SHALL keep the attestation's committed counts in lockstep with the store it
mutates (a cheap recount), so that ordinary incremental editing — including bulk deletions — does not
drive the persisted counts below the build-time baseline and falsely report `degraded`. The refresh
SHALL update COUNTS ONLY: the schema version and digest belong to the full build that wrote the
attestation and SHALL be carried forward verbatim. The refresh SHALL REFUSE to cross a schema boundary —
when the live store's schema differs from the attestation's, it SHALL leave the attestation untouched so
the load-time verdict still observes `mismatched`; a refresh SHALL NEVER re-stamp the schema and mask
that drift. When no attestation exists, the watcher SHALL NOT fabricate one.

The verdict SHALL be computed at load (on a cache miss) and carried on the loaded context; it is not
recomputed on every cached read. Because the watcher keeps the attestation in lockstep with the store it
just persisted, a subsequent cold reconcile of a watcher-updated index stays `healthy`. Folding a lagging
write-ahead log before a recount SHALL use a passive checkpoint, so the read path never blocks on a
concurrent writer.

#### Scenario: A half-built index is reported degraded, not healthy

- **GIVEN** an index whose persistence was interrupted so that far fewer edges landed on disk than
  extraction committed
- **WHEN** the plausibility verdict is computed, after the checkpoint-and-recount retry
- **THEN** the verdict is `degraded`, not `healthy`

#### Scenario: An older-schema index is reported mismatched

- **GIVEN** a persisted index built at a previous schema version
- **WHEN** it is loaded and re-checked against its attestation
- **THEN** the verdict is `mismatched`

#### Scenario: A malformed attestation is unverifiable, never fabricated healthy

- **GIVEN** an `index-attestation.json` whose `committed` record is missing its numeric counts
- **WHEN** the index is loaded
- **THEN** the attestation is rejected as unverifiable (no verdict), not read as `healthy`

#### Scenario: Incremental deletions do not falsely report degraded

- **GIVEN** a healthy index whose watcher then deletes the nodes/edges of many removed files
- **WHEN** the index is loaded after the watcher refreshes the attestation counts
- **THEN** the verdict is `healthy`, reconciling against the current store, not `degraded` against the
  stale build-time counts

### Requirement: NoSilentServiceOfADegradedIndex

A `degraded` or `mismatched` index SHALL NOT be silently served as if complete, and an empty index
SHALL NOT be silently substituted for a degraded one. On detecting a non-`healthy` verdict at load, the
system SHALL emit a recoverable signal and make the condition visible to callers, and the remedy SHALL
be to report and recover (trigger or recommend a clean re-analyze), consistent with the corrupt-store
quarantine ethos. The integrity verdict SHALL be queryable on the health/status path, and when the
index is not `healthy`, the conclusion tools whose soundness depends on index completeness
(`find_dead_code`, `select_tests`, `analyze_impact`, and reachability) SHALL carry the degraded verdict
in their existing confidence-boundary / staleness disclosure rather than presenting a possibly-incomplete
negative answer as fact. Surfacing is advisory by default; any blocking on a degraded index is opt-in.

#### Scenario: A negative conclusion over a degraded index is labeled, not asserted

- **GIVEN** a `degraded` index and an agent calling `find_dead_code`
- **WHEN** the result is produced
- **THEN** the result carries the degraded integrity verdict in its confidence-boundary disclosure, so
  "appears unreachable" is distinguishable from "unreachable," rather than asserting the symbol is dead

#### Scenario: A degraded index is reported and recovered, not silently emptied

- **GIVEN** a persisted index that re-checks as `degraded` on load
- **WHEN** the system loads it
- **THEN** it emits a recoverable signal and triggers or recommends a clean re-analyze, and does not
  silently return an empty graph or serve the degraded graph as complete
