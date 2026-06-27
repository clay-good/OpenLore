# mcp-handlers spec delta

## ADDED Requirements

### Requirement: BitemporalMemoryValidity

Every memory SHALL carry, in addition to its transaction time (`recordedAt`), a deterministic
**valid-from** marker: `validFromCommit`, the `HEAD` commit SHA at the time the memory was recorded,
read from git with no LLM. When a memory is superseded it SHALL gain `invalidatedAt` and
`invalidatedByCommit`. These two axes — what code state the memory was valid for, and when OpenLore
learned/retired it — make memory history queryable without inference.

The `recall` tool SHALL accept an optional `asOf` (commit-ish). With `asOf`, `recall` SHALL return the
memories that were authoritative as of that commit — i.e. recorded at or before `asOf` and not
invalidated at or before `asOf` — reusing the existing relevance selection unchanged. Markers that
cannot be placed on the commit axis are handled fail-closed: an absent `validFromCommit` reads as
recorded-before-any-commit (legacy memories stay always-valid), while an invalidated memory with no
`invalidatedByCommit` is treated as already-retired and excluded from every `asOf` window.

#### Scenario: A memory records its valid-from commit

- **GIVEN** a `remember` call made while `HEAD` is at commit C
- **WHEN** the memory is persisted
- **THEN** the stored memory's `validFromCommit` equals C

#### Scenario: As-of recall reflects history

- **GIVEN** a memory superseded at commit C
- **WHEN** `recall` is invoked with `asOf` earlier than C
- **THEN** the memory is returned as authoritative; and with `asOf` at or after C it is absent from
  the authoritative set

### Requirement: ExplicitMemorySupersession

The `remember` tool (or a dedicated supersede operation) SHALL accept `supersedes: <memoryId>`,
marking the referenced prior memory as invalidated. Supersession SHALL be an explicit caller act, not
an inferred merge. An invalidated memory SHALL NOT appear in any authoritative recall path (per the
`AuthoritativeRecallInvariant`), but SHALL remain retrievable via `asOf` for history.

#### Scenario: Superseding retires the prior memory

- **GIVEN** memory M1 and a later `remember` call declaring `supersedes: M1`
- **WHEN** `recall` runs without `asOf`
- **THEN** M1 does not appear in the authoritative set and the new memory does

### Requirement: DeterministicContradictionSurfacing

When two authoritative (`fresh`, non-invalidated) memories resolve to the same anchor symbol,
`recall` and `orient` SHALL surface the pair as `unreconciled` — a conclusion-shaped signal that two
grounded memories describe the same symbol and should be reconciled or one superseded. The system
SHALL NOT silently present both as independent fact, and SHALL NOT use an LLM to choose between them.
The detection reflects the recall's active scope (a `task`/`type` filter narrows the set considered;
unfiltered `recall` is the store-wide guarantee), and `orient` surfaces it scoped to the task's
relevant/decision-governed files and only when the call-graph view is available.

#### Scenario: Two fresh memories on one symbol are flagged

- **GIVEN** two authoritative memories whose anchors resolve to the same symbol
- **WHEN** `recall` or `orient` produces its response
- **THEN** the pair is reported as `unreconciled`, not served as two independent authoritative facts

#### Scenario: Superseding clears the contradiction

- **GIVEN** an `unreconciled` pair on a symbol
- **WHEN** one memory is superseded
- **THEN** the surviving memory is authoritative and the `unreconciled` flag is gone

### Requirement: TypedMemoryClassification

The `remember` tool SHALL accept an optional `type` from a fixed, closed set — `invariant`, `gotcha`,
`rationale`, `convention`, `preference`, `todo`, `note` — defaulting to `note` when absent or
unrecognized. The type SHALL be a caller-supplied label; the system SHALL NOT infer, classify, or
override it with an LLM or heuristic. The `recall` tool SHALL accept an optional `type` filter that
restricts results to memories of that type. Legacy memories with no stored type SHALL behave as
`note`.

#### Scenario: Type is stored as given

- **GIVEN** a `remember` call with `type: "invariant"`
- **WHEN** the memory is persisted
- **THEN** the stored memory's type is `invariant`

#### Scenario: Recall filters by type

- **GIVEN** memories of types `invariant` and `todo` matching a task
- **WHEN** `recall` is invoked with a `type: "invariant"` filter
- **THEN** only the `invariant` memory is returned

#### Scenario: Absent type defaults to note

- **GIVEN** a `remember` call with no `type`
- **WHEN** the memory is persisted and later recalled
- **THEN** its type is `note`

### Requirement: ChangedSinceRecall

The `recall` tool SHALL accept an optional `changedSince` (commit-ish) that returns the memories
recorded or invalidated after that commit (most-recent first with no task; task relevance ranks first
when given, recency as tiebreak; exclusive boundary), reusing the bitemporal fields with no new
relevance model. A memory whose markers cannot be placed on the commit axis is fail-closed out. This
is the differential companion to `asOf`.

#### Scenario: Differential recall returns only later changes

- **GIVEN** memory M1 recorded at commit C1 and memory M2 recorded at commit C2 (C2 after C1)
- **WHEN** `recall` is invoked with `changedSince` set to C1
- **THEN** M2 is returned and M1 is not

### Requirement: ContentAnchorDedup

The `remember` tool SHALL key a memory's identity on a hash of its content together with its resolved
anchors, so that re-recording the same content about the same code updates the existing memory in
place rather than creating a second record. Dedup SHALL be exact hash equality; the system SHALL NOT
merge distinct memories or judge relative importance. `remember` SHALL continue to surface when a
memory is unanchored (and therefore cannot self-invalidate), so the caller can choose to anchor it.

#### Scenario: Re-recording identical content does not duplicate

- **GIVEN** a memory recorded with content X and anchor A
- **WHEN** `remember` is called again with the same content X and anchor A
- **THEN** the store contains one memory for (X, A), not two

#### Scenario: Same content on a different anchor is distinct

- **GIVEN** a memory recorded with content X and anchor A
- **WHEN** `remember` is called with content X and a different anchor B
- **THEN** both memories exist (they describe different code)
