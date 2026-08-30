# MCP Handlers Specification

> Behavioural requirements for specific MCP tool handlers (`src/core/services/mcp-handlers/*`)
> beyond the cross-cutting tool-quality rules in `mcp-quality`. Tool output classification and the
> conclusion-over-graph contract live in `mcp-quality`; this domain captures handler-specific
> navigation semantics.

## Purpose

Behavioural requirements for the individual MCP tool handlers (`src/core/services/mcp-handlers/*`)
— the per-tool navigation, memory, and governance semantics that sit beyond the cross-cutting
tool-surface rules owned by the `mcp-quality` domain.

## Requirements

### Requirement: CoarseToFineMapNavigation

The system SHALL expose a two-tier map of the call graph: a region tier where each community is a
single super-node with aggregated inter-region super-edges, and a function tier reached by drilling
into one region. The region tier SHALL be derivable without reading any function body, and drilling
in SHALL reuse the existing community-membership view. The region tier SHALL ship in the opt-in
`navigation` preset, not the minimal default surface.

#### Scenario: Region view returns super-nodes and super-edges only

- **GIVEN** an analyzed repository with multiple communities
- **WHEN** `get_map` is called without a community id
- **THEN** the response contains one super-node per community (label, member count, top files, top
  landmark) and super-edges weighted by inter-region call count, and contains no individual function
  bodies

#### Scenario: Drilling into a region returns its functions

- **GIVEN** a community id from the region view
- **WHEN** `get_map` is called with that id
- **THEN** the response is the function-granularity view of that community, equivalent to
  `get_cluster`

#### Scenario: Large maps disclose truncation

- **GIVEN** a repository with more communities than the region-view bound
- **WHEN** the region view is produced
- **THEN** it returns the top regions by size, sets a `truncated` flag, and reports how many regions
  were omitted (no silent capping)

### Requirement: GoalConditionedLandmarkPathfinding

The system SHALL provide a `find_path` tool that accepts `from` and `to` endpoints expressed as exact
names or as selectors (`landmark:<id>`, `role:entrypoint|hub|sink`, `file:<path>`), resolves them to
concrete functions, and returns the single cheapest call path between them with a bounded set of
alternates and a stated reason. Path cost SHALL use call-distance when available and hop-count
otherwise. The tool SHALL ship in the opt-in `navigation` preset, not the minimal default.

Each `role` selector SHALL resolve through an existing deterministic classifier and SHALL NOT
introduce a new threshold: `entrypoint` = the graph's entry points; `hub` = the existing critical-hub
set; `sink` = a call-graph leaf that is actually called, defined as **zero outgoing internal call
edges AND fan-in ≥ 1** (parameter-free — no "high fan-in" or "leaf-ish" cutoff).

#### Scenario: Role-based endpoints resolve and route

- **GIVEN** a request for `from = role:entrypoint`, `to = file:src/db/writer.ts`
- **WHEN** `find_path` is invoked
- **THEN** each endpoint resolves to concrete functions and the response returns the cheapest path
  from a resolved entry point to a function in that file, with `resolvedFrom`/`resolvedTo` shown

#### Scenario: Sink selector is parameter-free

- **GIVEN** a function with zero outgoing internal call edges and at least one caller, and another
  leaf function with no callers
- **WHEN** `to = role:sink` is resolved
- **THEN** the first function resolves as a sink and the uncalled leaf does not, using only the
  existing leaf classifier and fan-in ≥ 1 — with no tunable threshold

#### Scenario: Cheapest path reflects edge cost

- **GIVEN** a short weakly-resolved path and a longer strongly-resolved path between two endpoints
- **WHEN** `find_path` runs with call-distance enabled
- **THEN** it selects the strongly-resolved path and reports its distance and hops; with call-distance
  disabled it selects the fewest-hops path

#### Scenario: No path is an explicit answer

- **GIVEN** two endpoints with no call path within the depth/distance budget
- **WHEN** `find_path` is invoked
- **THEN** it returns a structured "no path within budget" result stating how far the search reached,
  not an empty list

#### Scenario: Response is conclusion-shaped

- **GIVEN** any successful `find_path` invocation
- **WHEN** the response is produced
- **THEN** it contains the chosen path chain plus at most a bounded number of alternates, and no
  unbounded node-and-edge dump

### Requirement: BuildTheMcpLivedataTestHarnessAsAnIntegrationonlyBehaviorneutralVerificationLayer

The system SHALL verify every registered MCP tool against real codebases via a live-data integration harness, with a static coverage gate ensuring all tools have driver entries even when offline.

> Decision recorded: f4bb8a8f
> Date: 2026-06-10

#### Scenario: Every tool has a live-data driver entry

- **WHEN** the live-data integration harness coverage gate runs
- **THEN** every registered MCP tool has a driver entry, even when the live harness itself is offline

### Requirement: ComputeCfgdefuseOverlayInsideLivetreeExtractorsExtendReturnContractToNodesRawedgesCfg

This domain SHALL conform to the canonical statement of decision `c8f2b9bf`, which lives in the
`analyzer` domain — see [analyzer/spec.md](../analyzer/spec.md).

#### Scenario: The canonical statement governs

- **GIVEN** decision `c8f2b9bf` recorded in the `analyzer` domain
- **WHEN** this domain's behavior touches that decision's surface
- **THEN** it satisfies the canonical requirement as stated in [analyzer/spec.md](../analyzer/spec.md)

### Requirement: AnchorPersistedMemoryToCallgraphSymbolsWithDeterministicFreshness

The system SHALL anchor persisted memories to call-graph symbols and compute deterministic fresh/drifted/orphaned verdicts on recall without LLM inference.

> Decision recorded: 34b178df
> Date: 2026-06-16

#### Scenario: Recall verdicts are deterministic

- **GIVEN** a memory anchored to a call-graph symbol
- **WHEN** it is recalled
- **THEN** its fresh/drifted/orphaned verdict is computed deterministically with no LLM inference

### Requirement: CodeanchoredMemoryStoreIsSeparateFromTheDecisionStore

The system SHALL persist agent memories in a dedicated store (.openlore/memory/notes.json) separate from the decision store, and SHALL surface both memory kinds through the recall tool with per-anchor freshness verdicts.

> Decision recorded: 517ab4c6
> Date: 2026-06-16

#### Scenario: Memories and decisions live in separate stores

- **WHEN** an agent memory is persisted
- **THEN** it is written to `.openlore/memory/notes.json`, not the decision store, and recall surfaces both kinds with per-anchor freshness verdicts

### Requirement: OrphanedMemoriesAreNeverServedAsAuthoritativeContext

The recall tool SHALL partition returned memories into authoritative and needsReanchoring sets, and SHALL never include orphaned memories in the authoritative set.

> Decision recorded: dbe6a95e
> Date: 2026-06-16

#### Scenario: An orphaned memory is partitioned out

- **GIVEN** a memory whose anchor no longer resolves
- **WHEN** recall returns it
- **THEN** it appears in needsReanchoring, never in the authoritative set

### Requirement: AuthoritativeRecallInvariant

The system SHALL guarantee, as a single named and test-enforced invariant, that **no
memory whose freshness verdict is `drifted` or `orphaned` ever appears in an authoritative
recall path unlabeled**. The authoritative recall paths are the `recall` tool and the
memory (decision) section of `orient`. An `orphaned` memory SHALL be fully withheld from
the authoritative set (surfaced only under `needsReanchoring` / `staleDecisions`); a
`drifted` memory MAY remain in the authoritative set only when it carries an explicit
`verify` label. This invariant is the operational definition of the project promise:
*OpenLore never serves an unverified or stale fact as authoritative.* It SHALL be enforced
by a property-based test (`memory-invariant.test.ts`) that generates arbitrary memories and
arbitrary code mutations and asserts the property holds for every generated case.

#### Scenario: A drifted memory is excluded from the authoritative set unlabeled

- **GIVEN** a memory whose anchor verdict is `drifted`
- **WHEN** `recall` or `orient` produces its response
- **THEN** the memory does not appear in the authoritative set unlabeled; it is withheld or
  carries an explicit verify/non-authoritative label

#### Scenario: The invariant holds under generated mutation

- **GIVEN** an arbitrary memory and an arbitrary mutation to the code it anchors
- **WHEN** the authoritative recall path is computed
- **THEN** the authoritative set contains only `fresh` memories and explicitly-labeled
  `drifted` ones, never an `orphaned` memory

### Requirement: FreshnessFailsSafeTowardDistrust

The freshness computation (`anchorFreshness`, `hashSpan`) SHALL fail safe toward distrust:
any ambiguity, hash collision, or boundary error SHALL bias the verdict toward `drifted` or
`orphaned`, never toward a false `fresh`. A renamed, moved, or deleted symbol SHALL yield
`orphaned` (or `drifted` only when a confident relocation is established). `hashSpan` SHALL
slice spans by byte offset so multibyte UTF-8 boundaries hash correctly. A test that
produces a false `fresh` SHALL be treated as a correctness failure; a false `orphaned` is
acceptable. This is guarded by the adversarial suite (`anchor-adversarial.test.ts`).

#### Scenario: A forced collision does not produce false fresh

- **GIVEN** two distinct source spans
- **WHEN** freshness is computed for a memory anchored to one after the other replaces it
- **THEN** the verdict is `drifted` or `orphaned`, never `fresh` (distinct spans do not
  collide on the truncated content hash; a collision would fail the suite loudly)

#### Scenario: A multibyte span boundary hashes correctly

- **GIVEN** an anchored span whose start or end falls on a multibyte UTF-8 boundary
- **WHEN** `hashSpan` computes the content hash before and after an unrelated edit elsewhere
- **THEN** the hash is byte-correct and stable, producing `fresh` only when the span bytes
  are unchanged

### Requirement: ConcurrentMemoryWriteSafety

The `remember` and `record_decision` tools SHALL be safe under concurrent invocation: two
concurrent writes to the same store SHALL NOT cause either write to be lost. On a write
conflict the system SHALL re-read the current store and re-apply the pending
append/upsert (compare-and-swap on a monotonic `sequence`), rather than overwrite the
competing write.

#### Scenario: Concurrent remember calls lose no write

- **GIVEN** N concurrent `remember` calls against the same memory store
- **WHEN** all calls complete
- **THEN** the persisted store contains all N memories

### Requirement: DecisionsCarryStructuralAnchorsForSelfinvalidation

The system SHALL resolve structural anchors against the call graph when recording a decision, falling back to file-level anchors when no analysis is available.

> Decision recorded: 10e6a55e
> Date: 2026-06-16

#### Scenario: Anchors resolve against the graph with a file-level fallback

- **WHEN** a decision is recorded
- **THEN** its structural anchors are resolved against the call graph, falling back to file-level anchors when no analysis is available

### Requirement: ValuelevelImpacttraceFallsBackToFunctionGranularityOnIllposedQueriesInsteadOfReportingZero

This domain SHALL conform to the canonical statement of decision `a37d851f`, which lives in the
`analyzer` domain — see [analyzer/spec.md](../analyzer/spec.md).

#### Scenario: The canonical statement governs

- **GIVEN** decision `a37d851f` recorded in the `analyzer` domain
- **WHEN** this domain's behavior touches that decision's surface
- **THEN** it satisfies the canonical requirement as stated in [analyzer/spec.md](../analyzer/spec.md)

### Requirement: DowngradeStableidMoveConfidenceFromExactToStableidWithVerifySemantics

The system SHALL report cross-file stable-id matches with confidence 'stable-id' and instruct the consumer to verify, rather than asserting the match is exact.

> Decision recorded: a3ede102
> Date: 2026-06-16

#### Scenario: A cross-file stable-id match says verify

- **WHEN** a cross-file stable-id match is reported
- **THEN** its confidence is `stable-id` with verify semantics, never asserted as exact

### Requirement: AnchorStableidParametergroupDetectionToTheSymbolsOwnNameNotTheFirstParenthesis

The system SHALL anchor stableId parameter-group detection to the symbol's own name so that body edits never alter the identifier.

> Decision recorded: 52b10e56
> Date: 2026-06-16

#### Scenario: Body edits never alter the identifier

- **GIVEN** a symbol whose body contains parenthesized expressions before the parameter list
- **WHEN** the stableId is computed
- **THEN** parameter-group detection anchors to the symbol's own name and body edits do not change the id

### Requirement: PersonalizedPagerankAsQueryconditionedRetrievalRankingNotGlobalSalience

This domain SHALL conform to the canonical statement of decision `0bdd4319`, which lives in the
`analyzer` domain — see [analyzer/spec.md](../analyzer/spec.md).

#### Scenario: The canonical statement governs

- **GIVEN** decision `0bdd4319` recorded in the `analyzer` domain
- **WHEN** this domain's behavior touches that decision's surface
- **THEN** it satisfies the canonical requirement as stated in [analyzer/spec.md](../analyzer/spec.md)

### Requirement: EpistemicLeaseEmitsNeutralFreshnessFactsNotCoerciveImperatives

The system SHALL surface epistemic-lease freshness as neutral factual signals (elapsed time, cognitive load, index-behind-HEAD) rather than imperative commands directed at the consuming agent.

> Decision recorded: 8e95746d
> Date: 2026-06-16

#### Scenario: The lease states facts, not commands

- **WHEN** the epistemic lease preamble fires
- **THEN** it reports neutral factual signals (elapsed time, cognitive load, index-behind-HEAD) and contains no imperative directed at the agent

### Requirement: UseADeterministicFieldweightedRankerForRecallNoLearnedModel

This domain SHALL conform to the canonical statement of decision `08005eb9`, which lives in the
`analyzer` domain — see [analyzer/spec.md](../analyzer/spec.md).

#### Scenario: The canonical statement governs

- **GIVEN** decision `08005eb9` recorded in the `analyzer` domain
- **WHEN** this domain's behavior touches that decision's surface
- **THEN** it satisfies the canonical requirement as stated in [analyzer/spec.md](../analyzer/spec.md)

### Requirement: BitemporalMemoryValidity

Every memory SHALL carry, in addition to its transaction time (`recordedAt`), a deterministic
**valid-from** marker: `validFromCommit`, the `HEAD` commit SHA at the time the memory was recorded,
read from git with no LLM. When a memory is superseded it SHALL gain `invalidatedAt` and
`invalidatedByCommit`. The `recall` tool SHALL accept an optional `asOf` (commit-ish) and return the
memories authoritative as of that commit — recorded at or before `asOf` and not invalidated at or
before it — comparing valid-time via git ancestry (`merge-base --is-ancestor`), not wall-clock,
reusing the existing relevance selection unchanged. A memory whose valid-time markers cannot be
placed on the commit axis is handled fail-closed: an absent `validFromCommit` reads as recorded
before any commit (legacy memories stay always-valid), but an invalidated memory with no
`invalidatedByCommit` is treated as already-retired and excluded from every `asOf` window rather than
revived into a result we cannot prove it belonged to.

#### Scenario: A memory records its valid-from commit
- **GIVEN** a `remember` call made while `HEAD` is at commit C
- **WHEN** the memory is persisted
- **THEN** the stored memory's `validFromCommit` equals C

#### Scenario: As-of recall reflects history
- **GIVEN** a memory superseded at commit C
- **WHEN** `recall` is invoked with `asOf` earlier than C
- **THEN** the memory is returned as authoritative; and with `asOf` at or after C it is absent

> Decision recorded: 48771c59
> Date: 2026-06-18

### Requirement: ExplicitMemorySupersession

The `remember` tool SHALL accept `supersedes: <memoryId>`, marking the referenced prior memory as
invalidated. Supersession SHALL be an explicit caller act, not an inferred merge. An invalidated
memory SHALL NOT appear in any authoritative recall path (per the `AuthoritativeRecallInvariant`),
but SHALL remain retrievable via `asOf` for history.

#### Scenario: Superseding retires the prior memory
- **GIVEN** memory M1 and a later `remember` call declaring `supersedes: M1`
- **WHEN** `recall` runs without `asOf`
- **THEN** M1 does not appear in the authoritative set and the new memory does

### Requirement: DeterministicContradictionSurfacing

When two authoritative (`fresh`, non-invalidated) memories resolve to the same anchor symbol,
`recall` and `orient` SHALL surface the pair as `unreconciled` — a conclusion-shaped signal that two
grounded memories describe the same symbol and should be reconciled or one superseded. The system
SHALL NOT silently present both as independent fact, and SHALL NOT use an LLM to choose between them.
The signal SHALL be a pure set intersection over symbol-level anchors (file-level anchors are too
coarse to count).

The detection SHALL reflect the recall's active scope: it is computed over the set the query already
selected, so a `task` (score) or `type` filter narrows the memories considered (e.g. a cross-type
contradiction is not flagged under a `type` filter). An unfiltered `recall` (no task, no type) is the
store-wide guarantee. `orient` surfaces the signal scoped to the task's relevant and decision-governed
files and only when the call-graph view is available — without an edge store it cannot verify
freshness, so it surfaces nothing rather than guess; `recall` is the unscoped path.

#### Scenario: Two fresh memories on one symbol are flagged
- **GIVEN** two authoritative memories whose anchors resolve to the same symbol
- **WHEN** an unfiltered `recall`, or `orient` with a graph view, produces its response
- **THEN** the pair is reported as `unreconciled`, not served as two independent authoritative facts

### Requirement: TypedMemoryClassification

The `remember` tool SHALL accept an optional `type` from a fixed, closed set — `invariant`, `gotcha`,
`rationale`, `convention`, `preference`, `todo`, `note` — defaulting to `note` when absent or
unrecognized. The type SHALL be a caller-supplied label; the system SHALL NOT infer, classify, or
override it. The `recall` tool SHALL accept an optional `type` filter that restricts results to
memories of that type. Legacy memories with no stored type SHALL behave as `note`.

#### Scenario: Type is stored as given and filters recall
- **GIVEN** a `remember` call with `type: "invariant"` and another with `type: "todo"`
- **WHEN** `recall` is invoked with a `type: "invariant"` filter
- **THEN** only the `invariant` memory is returned, and an absent/unknown type reads as `note`

### Requirement: ChangedSinceRecall

The `recall` tool SHALL accept an optional `changedSince` (commit-ish) that returns the memories
recorded or invalidated after that commit, reusing the bitemporal fields with no new relevance model.
With no `task` the result is ordered most-recent first (record-time descending); when a `task` is
given its relevance score ranks first and record-time is the tiebreak. The boundary is exclusive: a
memory recorded *at* `changedSince` is not returned. A memory whose record or invalidation commit
cannot be placed on the commit axis (no `validFromCommit` / `invalidatedByCommit`) is fail-closed out
of the differential rather than guessed in. This is the differential companion to `asOf`.

#### Scenario: Differential recall returns only later changes
- **GIVEN** memory M1 recorded at commit C1 and memory M2 recorded at commit C2 (C2 after C1)
- **WHEN** `recall` is invoked with `changedSince` set to C1
- **THEN** M2 is returned and M1 is not

### Requirement: ContentAnchorDedup

The `remember` tool SHALL key a memory's identity on a hash of its content together with its resolved
anchors, so that re-recording the same content about the same code updates the existing memory in
place rather than creating a second record. Dedup SHALL be exact hash equality; the system SHALL NOT
merge distinct memories or judge relative importance.

#### Scenario: Re-recording identical content does not duplicate
- **GIVEN** a memory recorded with content X and anchor A
- **WHEN** `remember` is called again with the same content X and anchor A
- **THEN** the store contains one memory for (X, A); the same content on a different anchor B is distinct

### Requirement: PreflightStructuralBriefing

The system SHALL provide a pre-flight capability that, given a staged or working diff, returns a
deterministic conclusion-shaped briefing of the change's structural blast radius: affected callers and
layers crossed, the tests to run, the anchored memories and decisions the diff will turn `drifted` or
`orphaned`, the specs it will make stale, and (under federation) the cross-repo consumers of any
changed published interface. The briefing SHALL compose existing deterministic analyses only, with no
LLM and no new structural computation, and SHALL be a briefing (counts and named risks), never a graph.

> Decision recorded: 987286eb
> Date: 2026-06-18

#### Scenario: A hub change is briefed before commit

- **GIVEN** a working diff that modifies a function with many callers and an anchored decision
- **WHEN** the pre-flight briefing is requested
- **THEN** it reports the caller count and layers, the tests to run, and that the anchored decision
  will drift — as a single conclusion-shaped briefing

### Requirement: AdvisoryByDefault

The pre-flight guard SHALL be non-blocking by default: surfaced on demand or via an advisory git hook
that does not fail a commit. A repository MAY opt into blocking for specific high-risk patterns (for
example, orphaning an anchored decision) via configuration, but blocking SHALL never be the default
posture.

#### Scenario: Default hook is advisory

- **GIVEN** the pre-flight git hook installed with default configuration
- **WHEN** a commit is made for a high-blast-radius diff
- **THEN** the briefing is emitted and the commit is not blocked

#### Scenario: Opt-in blocking fires only on its pattern

- **GIVEN** a repository configured to block when a commit orphans an anchored decision
- **WHEN** a commit would orphan an anchored decision
- **THEN** the hook blocks; and for any other high-blast-radius diff it remains advisory

### Requirement: ConfidenceBoundaryOnConclusions

Every conclusion-shaped answer (`analyze_impact`, `find_path`, `find_dead_code`, `get_subgraph`,
`select_tests`, `recall`, `trace_execution_path`) SHALL carry a deterministic `confidenceBoundary`
describing its epistemic basis: the portion resting on directly-resolved edges, the portion resting on
synthesized edges (named by their `synthesizedBy` rule), and any **known-unknowable** crossings — a
traversal that passed a reflection or computed-dispatch boundary, or, under federation, an unindexed
repository. The boundary SHALL be categorical labels and counts, never a blended confidence score, and
SHALL be additive metadata that callers may ignore. It SHALL be computed without an LLM, from the
edge `confidence`/`synthesizedBy` provenance already present (decision `08e71184`).

#### Scenario: A clean answer reports a clean boundary

- **GIVEN** a query answered entirely via directly-resolved edges against a current index
- **WHEN** the response is produced
- **THEN** its `confidenceBoundary` reports only directly-resolved basis, no known-unknowable crossing,
  and `complete: true`

#### Scenario: A boundary-crossing answer is flagged, not hidden

- **GIVEN** a `find_dead_code` query whose liveness partition is reached only across a synthesized
  (heuristically-recovered dispatch) edge
- **WHEN** the response is produced
- **THEN** the `confidenceBoundary` names the synthesized crossing as known-unknowable, breaks down the
  synthesized edges by rule, and reports `complete: false`

### Requirement: StalenessBoundary

When graph-relevant source files have changed since the index's build commit, every conclusion SHALL
carry a staleness marker naming that build commit and the count of source files changed since it,
derived deterministically from `git diff` against the commit captured at analyze time. A current index
(zero source files changed) SHALL produce no staleness marker. When staleness cannot be assessed
reliably — no build commit was captured, or the project is not a git repository — the system SHALL
stay silent rather than emit a false-positive marker.

#### Scenario: A stale index is disclosed

- **GIVEN** an index built at commit X and a working tree with N files changed since X
- **WHEN** any conclusion is produced
- **THEN** the response discloses "computed against the index at commit X; N file(s) changed since" and
  reports `complete: false`

> Decision recorded: 08e71184
> Date: 2026-06-18

### Requirement: ExcludeAllOpenloreprefixedDirsFromTheProjectFingerprintSoOpenloresOwnCachesDontInvalidateTheAnalysisCache

The system SHALL exclude all directories whose name starts with `.openlore` from project fingerprint computation so that OpenLore-managed caches do not invalidate analysis freshness.

> Decision recorded: cd5ff82c
> Date: 2026-06-18

#### Scenario: OpenLore's own caches do not invalidate freshness

- **WHEN** the project fingerprint is computed
- **THEN** every directory whose name starts with `.openlore` is excluded, so OpenLore-managed cache writes do not change the fingerprint

### Requirement: ExcludeSupersededDecisionsFromAuthoritativeRecallViaOneSharedSupersessionPredicate

The system SHALL exclude superseded decisions from authoritative recall and orient context using a single shared supersession predicate, surfacing them only as reversal warnings.

> Decision recorded: 6c32e6c6
> Date: 2026-06-19

#### Scenario: A superseded decision surfaces only as a reversal warning

- **GIVEN** a decision superseded by a newer one
- **WHEN** recall or orient assembles context
- **THEN** the shared supersession predicate excludes it from authoritative results and it appears only as a reversal warning

### Requirement: SpecstoreBindingResolvesDeclaredTargetsByNameAgainstTheFederationRegistry

This domain SHALL conform to the canonical statement of decision `c6e36101`, which lives in the
`config` domain — see [config/spec.md](../config/spec.md).

#### Scenario: The canonical statement governs

- **GIVEN** decision `c6e36101` recorded in the `config` domain
- **WHEN** this domain's behavior touches that decision's surface
- **THEN** it satisfies the canonical requirement as stated in [config/spec.md](../config/spec.md)

### Requirement: StructuralClaimVerification

The system SHALL provide a `verify_claim` capability that accepts a structured claim
(`{ kind: 'calls' | 'reaches' | 'dead' | 'impacts' | 'safe-to-change' | 'decision-current', subject, object? }`)
and returns
a deterministic `{ verdict: 'confirmed' | 'refuted' | 'unverifiable', reason, receipt?, confidenceBoundary }`.
The verdict SHALL be computed by the existing deterministic analysis for that claim kind (call-graph
traversal for `calls`/`reaches`, backward reachability for `impacts`, mark-and-sweep reachability for
`dead`, directly-resolved caller analysis for `safe-to-change`), never by an LLM and never as a
confidence number. A `confirmed` or `refuted` verdict SHALL carry a receipt — the subject/object spans
and content hashes (grounding-certificate shape) plus the index commit — suitable for the agent to cite
to a human. A claim whose answer rests on a dispatch blind spot (a symbol reached only through
synthesized dynamic-dispatch edges, or an unresolved/ambiguous symbol) SHALL return `unverifiable` with
the boundary named (reusing the confidence-boundary disclosure), never a fabricated `confirmed`/`refuted`.
The capability SHALL be conclusion-shaped (verdict + bounded receipt, never a graph to traverse) and
registered only in an opt-in preset (`verify`), never in the minimal or first-run default surface.

The `decision-current` kind extends the same verdict contract from the call graph to the recorded
decision store (change: add-decision-reference-claim-verification), so an agent about to cite a decision
to a human ("decision X governs this, so it is safe") can first check that X is still authoritative. Its
`subject` is an 8-character decision id (not a symbol). The verdict SHALL be a pure read of the decision
store, sharing the SAME retirement graph the `stale-decision-reference` finding walks so the two can
never disagree about what counts as superseded: `confirmed` when the id resolves to a recorded decision
that is neither superseded nor rejected; `refuted` when it has been superseded (the reason naming the
live terminal superseder to cite instead) or was rejected; `unverifiable` when the id is malformed or no
such decision is recorded in this repository. This kind verifies against the decision store only and
SHALL NOT load or contort the structural call-graph verifier.

#### Scenario: A false claim is refuted with a receipt

- **GIVEN** a claim that function A calls function B, when no such edge exists
- **WHEN** the claim is verified
- **THEN** the verdict is `refuted` with a receipt referencing the index commit and the relevant spans

#### Scenario: A blind-spot claim is unverifiable, not fabricated

- **GIVEN** a `dead` claim about a symbol reachable only through synthesized dynamic-dispatch edges
- **WHEN** the claim is verified
- **THEN** the verdict is `unverifiable` with the dispatch boundary named, never `confirmed` or `refuted`

#### Scenario: Citing a superseded decision is refuted, naming the superseder

- **GIVEN** a `decision-current` claim about a decision id that a later decision supersedes
- **WHEN** the claim is verified
- **THEN** the verdict is `refuted`, the reason names the live superseding decision to cite instead, and the receipt carries the retired decision and its `supersededBy`

#### Scenario: An unknown decision id is unverifiable, not fabricated

- **GIVEN** a `decision-current` claim whose id is well-formed but recorded in no decision in this repository
- **WHEN** the claim is verified
- **THEN** the verdict is `unverifiable` (hedge or read the source), never a fabricated `confirmed`

### Requirement: ProactiveIntentBriefing

`orient` SHALL, for the symbols and files in a task's scope, proactively surface relevant prior
decisions and `remember` notes as part of orientation — without the agent having to ask for history
it is unaware of. Surfaced intent SHALL include records authored by any agent or human (not only the
current session) and SHALL carry a freshness verdict per the authoritative-recall invariant: orphaned
intent is withheld from the authoritative set (segregated as stale), drifted intent is flagged to
verify. (Realized by orient's `pendingDecisions` / `staleDecisions` / `unreconciledMemories` briefing.)

#### Scenario: Orientation surfaces an in-scope constraint with its verdict

- **GIVEN** a decision anchored to a function in the task's scope
- **WHEN** `orient` runs for that task
- **THEN** the decision is surfaced in the briefing with its freshness verdict

### Requirement: ReversalAwareness

When intent in a task's scope was superseded or reverted, **`orient` and `recall`** SHALL surface it in
an additive `reversals` field as an explicit do-not-repeat warning — naming the commit at which a memory
was retired (its `invalidatedByCommit` = HEAD when the superseding memory was recorded, which is the
commit the note was retired *as of*, not a verified "this commit reverted the code" claim) and the
recorded reason (the superseding record's content/rationale) — rather than silently omitting reverted
history, because the absence of a do-not-repeat signal is what lets an agent re-introduce a deliberately
removed approach. A reverted **memory** is one with `invalidatedAt` set; a reverted **decision** is one
targeted by another, non-`rejected`/`phantom` decision's `supersedes` (a *declined* supersession leaves
the original standing). The two surfaces differ only in scope: `orient` by the task's relevant
files/domains, `recall` by task relevance (so a fully-reverted approach surfaces even with no current
memory on its file). Reverted intent SHALL NOT be re-served as authoritative current context, only as
cautionary history; a superseded decision SHALL be excluded from the authoritative set by the same
supersession predicate that surfaces it as a reversal, so the two surfaces can never disagree — including
in the pre-consolidation window where the superseded decision's own status has not yet flipped to
`rejected` (e.g. with no LLM configured). Selection is deterministic retrieval over already-recorded
supersession records; no LLM. The field SHALL be bounded with an explicit omission note (never a silent
truncation of history) and omitted entirely when nothing in scope was reverted.

#### Scenario: A reverted approach is surfaced as do-not-repeat

- **GIVEN** an approach recorded and later retired as of commit Y with a reason
- **WHEN** an agent orients on the code that approach touched
- **THEN** the briefing's `reversals` warns "Do not re-attempt … (retired as of commit Y) — recorded reason: …", rather than omitting it

#### Scenario: Reverted intent is never served as authoritative

- **GIVEN** a decision superseded by a later decision whose own status is still `approved`/`draft`/`verified` (consolidation has not yet flipped it to `rejected`)
- **WHEN** `orient` or `recall` runs for a task in that decision's scope
- **THEN** the superseded decision appears only under `reversals`, never under `pendingDecisions` / the authoritative recall set

### Requirement: FleetLevelAnchoredMemory

A memory **or decision** anchored to a published interface SHALL surface, with its freshness verdict,
when an agent recalls while editing a consumer repository that references that interface. `recall` SHALL
accept the opt-in `federation` / `federationRepos` params (inert without an `.openlore/federation.json`
registry) and, when active, return a `fleetMemory` block with `memories` and `decisions` arrays: for
each upstream interface the home repo references (its external call edges), it loads each scoped producer
repo's index once, selects the producer memories and active decisions anchored to that interface (matched
by exact symbol name — arity/overload unconfirmed at an external call site), and computes each record's
freshness against the **producer's** graph. A fleet-level record whose anchor no longer exists in the
producer SHALL be `orphaned` and withheld from the authoritative set, identically to a single-repo
record; a retired (invalidated) producer memory or an inactive (rejected/synced/phantom) producer
decision SHALL likewise be excluded. The selection SHALL be deterministic (no LLM), bounded per kind with
an explicit omission note, and SHALL name the repos consulted and skipped (a stale/unindexed producer is
reported, never guessed). Note a deliberate consequence of the `synced` exclusion across the boundary: a
producer decision that reaches its finalized `synced` state (its content folded into the producer's local
ADRs / `spec.md`) is intentionally NOT federated, because that content lives in producer-local specs a
consumer cannot read — so the decision side surfaces primarily transient `draft`/`approved`/`verified`
producer decisions, and an empty `fleetMemory.decisions` does not imply the producer recorded no
architectural constraints on the interface.

#### Scenario: A producer-side memory surfaces in a consumer

- **GIVEN** a fresh memory anchored to an interface exported by repo A, and consumer repo B references it
- **WHEN** an agent recalls in B with `federation` active
- **THEN** the memory surfaces in B's `fleetMemory` carrying its freshness verdict, naming repo A

#### Scenario: An orphaned fleet memory is withheld

- **GIVEN** a producer memory whose anchor symbol no longer exists in the producer
- **WHEN** an agent recalls in a consumer repo with `federation` active
- **THEN** the memory does not appear as authoritative, even though the producer repo was consulted

### Requirement: SpecStoreBinding

The system SHALL support an optional, additive binding between an OpenLore-indexed environment and an
external spec repository that declares the code repositories its plans target and reference. The binding
SHALL consist of the store's name, its local path, a list of declared **target** repositories, and an
optional list of declared **reference** repositories. The binding SHALL be configuration only: the
system SHALL read the store's declared relationships and SHALL NOT clone, write to, synchronize, or
fence the store or any target. When no binding is configured, single-repository behavior SHALL be
unchanged.

#### Scenario: A binding declares targets and references

- **GIVEN** an OpenLore environment configured with a spec-store binding naming two target repositories
  and one reference repository
- **WHEN** the binding is loaded
- **THEN** the system records the store name, path, targets, and references, and makes no modification to
  the store or any target

#### Scenario: Absent binding preserves single-repo behavior

- **GIVEN** an environment with no spec-store binding configured
- **WHEN** OpenLore runs
- **THEN** behavior is identical to the unbound single-repository case and no binding error is raised

### Requirement: SpecStoreNameResolution

The system SHALL resolve declared target and reference names to local repository indexes via the
multi-repository federation index-of-indexes, and resolved targets SHALL carry their live index state so
that cross-repository structural facts are computable across the plan's targets. A declared name that
does not resolve to a registered repository SHALL produce a finding (`target-unresolved` for targets,
`reference-missing` for references) rather than an error, and the remaining names SHALL still resolve.

#### Scenario: One target is missing

- **GIVEN** a binding declaring three targets, one of which is not registered in the federation registry
- **WHEN** names are resolved
- **THEN** two targets resolve and exactly one `target-unresolved` finding is reported for the missing
  target

### Requirement: SpecStoreHealthCheck

The system SHALL provide a deterministic, read-only, conclusion-shaped health check for a spec-store
binding that reports, per declared target, whether it resolves, whether its index is present, and
whether its index is fresh relative to its working tree; per declared reference, whether it is present;
the presence of the store's own path; and any malformed-binding problems. Each finding SHALL carry a
stable code (`no-binding`, `binding-invalid`, `registry-unreadable`, `store-path-missing`,
`target-unresolved`, `target-missing`, `index-missing`, `index-stale`, `reference-missing`) and a
pasteable remediation. The check SHALL NOT block, SHALL be sound when it carries no error-severity
finding, and SHALL degrade infrastructure failures (no federation, not a repository, **a corrupt
federation registry**) to a finding rather than throwing — on every surface, including the MCP dispatch
path, not only the CLI. The check SHALL compose existing analyses only, with no LLM.

#### Scenario: A healthy binding reports no findings

- **GIVEN** a binding whose every target resolves to a present, fresh index and whose references are all
  present
- **WHEN** the health check runs
- **THEN** it returns zero findings and a sound verdict

#### Scenario: A stale target index is surfaced

- **GIVEN** a binding whose target index is older than that target's working tree
- **WHEN** the health check runs
- **THEN** it returns exactly one finding with the stable code `index-stale` and a remediation, and does
  not block

#### Scenario: A corrupt federation registry degrades to a finding, never a throw

- **GIVEN** a configured binding and a corrupt or malformed `.openlore/federation.json`
- **WHEN** the health check runs (including via the MCP dispatch path)
- **THEN** it returns a report carrying a `registry-unreadable` finding rather than throwing, and it does
  not emit a misleading `target-unresolved` finding for each declared target

### Requirement: WorkingSetContextBriefing

The system SHALL provide a capability that, given a configured spec-store binding and an active change,
assembles a single deterministic, conclusion-shaped structural briefing spanning the change's target
repositories. For each target the briefing SHALL surface the relevant functions, callers, insertion
points, and governing specs for the change's scope, together with the fresh, in-scope prior decisions and
constraints anchored to that code. The briefing SHALL compose existing task-scoped orientation only, with
no LLM and no new relevance model, and SHALL be a briefing, never a raw graph. The capability SHALL be
read-only and SHALL degrade every binding/change/index problem to a finding (stable codes: `no-binding`,
`binding-unsound`, `change-unspecified`, `change-not-found`, `no-briefable-targets`,
`target-not-briefable`, `orient-unavailable`) rather than throwing or blocking.

#### Scenario: A change spanning two targets is briefed

- **GIVEN** a bound store and an active change whose declared targets resolve to two indexed repositories
- **WHEN** the working-set context is requested for that change
- **THEN** the system returns one briefing whose items each name their target repository and symbol, and
  surface the relevant functions, callers, insertion points, and governing specs in each target

### Requirement: WorkingSetContextIsBudgetedAndAttributed

The working-set briefing SHALL be bounded by the trust-calibrated context budget, ranked by structural
relevance to the change's scope, and SHALL emit an explicit omission note when truncated rather than
silently dropping items. Every item SHALL be attributed to its target repository. In-scope anchored
intent SHALL be included with its freshness verdict; orphaned intent SHALL be withheld and drifted intent
SHALL be flagged. Approved decisions awaiting sync MAY additionally be surfaced for sync-awareness,
distinguishable by their status.

#### Scenario: An over-budget working set is truncated transparently

- **GIVEN** a change whose targets would produce more context than the configured budget allows
- **WHEN** the working-set context is assembled
- **THEN** the briefing is truncated to budget, ranked by relevance, and carries an omission note stating
  what was dropped

#### Scenario: Orphaned intent is not briefed as current

- **GIVEN** an in-scope decision whose anchor has been orphaned by later edits
- **WHEN** the working-set context is assembled
- **THEN** the orphaned intent is withheld from the briefing and not presented as current

### Requirement: CoveringSurfaceDeclaration

The system SHALL support an optional, additive declaration of named **covering surfaces**, where a
surface is a set of symbols, files, or published interfaces representing a semantic or governance
boundary, with an optional severity. A surface SHALL be resolvable to a concrete symbol-ID set over the
(federated) graph; an unresolved surface member SHALL degrade to a finding rather than throwing. A
covering surface SHALL be a declared boundary, not a directory-ownership glob, and SHALL be the unit a
proposed change is assessed against.

> Implemented by `add-change-impact-certificate` (2026-06-21). Surfaces are declared under
> `OpenLoreConfig.impactCertificate.surfaces`; `resolveSurfaces` resolves a `symbol` member to exactly
> one indexed node (ambiguous/unknown → `surface-unresolved-member` finding) and a `file` member to all
> its internal symbols (empty → `surface-empty`). Decision: `187224b0`.

#### Scenario: A surface resolves to a symbol set

- **GIVEN** a covering surface declared as a mix of one file and two symbols
- **WHEN** the surface is resolved over the graph
- **THEN** it resolves to the expected set of symbol IDs, and any member that does not resolve produces a
  finding rather than an error

### Requirement: NewlyOpenedPathDetection

The system SHALL, given a proposed change, compute reachability to each declared covering surface in the
pre-change graph and in the post-change graph — the latter derived by applying the change's diff to the
call graph — and SHALL report the paths into each surface that exist only in the
post-change graph. These newly-opened paths SHALL be reported distinctly from the surface's existing
callers. For each newly-opened path the system SHALL name the shortest opening path. The computation
SHALL be deterministic, with no LLM.

> Implemented by `add-change-impact-certificate` (2026-06-21). The post-change graph is derived by a
> bounded **differential edge-delta over the changed files** (re-parse changed files at base vs working
> tree; adjust the canonical adjacency: post = canonical + added − removed, pre = canonical − added +
> removed), NOT the incremental dependency graph (`add-watch-incremental-dependency-graph`), which is
> still unbuilt. A new call edge can only originate from a changed file, so this detects every
> newly-opened path without a full rebuild. Added callee names that resolve ambiguously are reported as
> `unresolved-added-call`, never guessed; a call resolved to a same-diff local definition binds to that
> local (no homonym phantom opening). The changed-file set is complete: old content is read from the
> MERGE-BASE (the same baseline `getChangedFiles` diffs against, so the certificate's blast-radius and
> path halves never disagree), renamed files read their old content from the base-ref `oldPath` (a pure
> rename opens nothing), and brand-new UNTRACKED files are folded in (a new file's opening is never
> missed) — all regression-tested against a real git repo. Decisions: `187224b0`, `97c22605`, `c2fbacf9`.

#### Scenario: A change opens a new transitive path into a surface

- **GIVEN** a covering surface and a proposed change whose diff adds an edge creating a two-hop path into
  that surface where none existed before
- **WHEN** newly-opened-path detection runs
- **THEN** it reports exactly that newly-opened path into the surface, naming the shortest opening path,
  and does not report it as a pre-existing caller

#### Scenario: A change touching only existing callers opens nothing

- **GIVEN** a covering surface and a proposed change that modifies only code already able to reach the
  surface
- **WHEN** newly-opened-path detection runs
- **THEN** it reports no newly-opened paths into that surface

### Requirement: ChangeImpactCertificate

The system SHALL emit, for a proposed change, a single deterministic, conclusion-shaped impact
certificate composed of: the change's blast radius (callers and layers), the newly-opened paths into
each declared covering surface, the specs the change drifts, and the tests to run. The certificate SHALL
compose existing deterministic analyses only, with no LLM, and SHALL be a briefing — counts, named
surfaces, named paths — never a raw graph. Each finding SHALL carry a stable code, and surface findings
SHALL carry the surface name and severity.

> Implemented by `add-change-impact-certificate` (2026-06-21) as MCP tool `change_impact_certificate`
> (classified `conclusion`; in the opt-in `federation` preset, out of minimal/navigation/memory). Blast
> radius, tests, and drift reuse `computeBlastRadius` verbatim. Decision: `187224b0`.

#### Scenario: A cross-boundary change is certified

- **GIVEN** a proposed change that opens a new path into a declared surface and drifts two specs
- **WHEN** the impact certificate is requested
- **THEN** it returns one conclusion-shaped certificate naming the newly-opened path and its surface, the
  two drifted specs, the affected callers and layers, and the tests to run

### Requirement: ImpactCertificateDecaysWithLease

The impact certificate SHALL be anchored to the change and its touched symbols via the existing
code-anchored freshness lease, and SHALL be marked stale when the change grows or an anchored symbol
moves. An expired certificate SHALL be treated as unverified and SHALL NOT be presented as silently
still-true. The spec-store health check SHALL surface a stale certificate as a finding so it can be
re-fired against current state.

> Implemented by `add-change-impact-certificate` (2026-06-21). A persisted certificate carries
> `StructuralAnchor`s over the touched symbols under `.openlore/impact-certificates/`; a changed file
> with no indexed symbol — a brand-new/untracked file the differential just assessed — is anchored at the
> FILE level instead, so the certificate still decays for the new code it certified rather than silently
> omitting it. `recheckCertificate` recomputes freshness via `memoryFreshness` against the current edge
> store (no graph to verify against → treated stale, never silently current). `handleSpecStoreStatus`
> re-checks each resolved+indexed target's persisted certificates (cheap-gated on the certs dir) and emits
> a `certificate-stale` finding. Decisions: `187224b0`, `c2fbacf9`.

#### Scenario: Editing an anchored symbol expires the certificate

- **GIVEN** a fresh impact certificate anchored to a set of symbols
- **WHEN** one of those symbols is subsequently modified
- **THEN** the certificate is marked stale, the health check surfaces it as a finding to re-fire, and the
  stale certificate is not reported as current

### Requirement: TaskScopedOrientationIsAmortizedNotDuplicated

Task-scoped context injection SHALL produce its orientation by reusing the existing orient handler in
its lean form (Spec 27), not by introducing a second orientation code path. The injected orientation
for a task SHALL be the same conclusion the agent would obtain by calling `orient` for that task,
presented in a bounded, injection-shaped form. The orientation algorithm, ranking, and result schema
SHALL be unchanged; injection is a presentation-and-gating wrapper over existing output.

> Implemented by `add-task-scoped-context-injection` (2026-06-22). `orient --inject` calls
> `handleOrient(directory, task, 8, undefined, true)` and renders the lean result; no orient logic is
> forked. Decision: `27c4bb53`.

#### Scenario: Injected orientation matches the orient conclusion

- **GIVEN** a task and an analyzed repository
- **WHEN** task-scoped injection produces its block and `orient --lean` is called for the same task
- **THEN** the injected block carries the same relevant functions, call neighbours, and insertion
  points as the lean orient result, bounded by the injection token budget

### Requirement: InjectedContextIsInformationalNotCoercive

An injected orientation block SHALL be framed as information the agent may act on or ignore, never as
an instruction. It SHALL open with an explicit informational/ignorable statement, the same facts-not-
coercion posture applied across OpenLore (decision `8e95746d`). Injection SHALL be deterministic and
SHALL NOT invoke an LLM.

> Implemented by `add-task-scoped-context-injection` (2026-06-22). The block opens with
> "[OpenLore] Task-scoped orientation (deterministic, from the local call graph). Informational — act
> on it or ignore it." and closes with a pointer to `orient`. No directive language. Decision: `27c4bb53`.

#### Scenario: The injected block does not command the agent

- **GIVEN** a task-scoped injection block emitted for a task
- **WHEN** the block is read
- **THEN** it presents structural facts under an explicit "informational; you decide whether to act on
  it" framing and contains no directive to take a specific action

### Requirement: GovernanceFindingsCarryStableCodeAndIntrinsicSeverity

Every governance finding source SHALL emit each finding carrying a stable, documented `code` and an
intrinsic `severity`. The `code` SHALL be stable across releases so a declared `enforcement.policy` can
name it; the `severity` SHALL be owned by the emitting source and SHALL NOT be overridden by the
enforcement policy. The canonical severity vocabulary SHALL be the closed set `info`, `warning`,
`error`, and `critical`; emitters SHALL normalize the legacy spelling `warn` to `warning`. Findings
SHALL be shaped so a single enforcement-class resolver can govern findings from all sources uniformly.

#### Scenario: A finding exposes the fields the policy needs

- **GIVEN** any governance finding emitted by any source
- **WHEN** the finding is inspected
- **THEN** it carries a stable `code` and an intrinsic severity from the canonical four-value vocabulary

#### Scenario: Existing per-surface block sugar maps onto the unified policy

- **GIVEN** a repository that previously expressed opt-in blocking through a per-surface `block: [...]` config
- **WHEN** the unified enforcement policy resolves that surface's finding codes
- **THEN** the resolved classes match the prior `block: [...]` intent

#### Scenario: Legacy warning spelling is normalized

- **GIVEN** a warning-level governance finding from any source
- **WHEN** the finding is serialized or passed to the enforcement resolver
- **THEN** its severity is `warning`, never the legacy value `warn`

### Requirement: StaleDecisionReferenceFinding

> Status: Implemented (change: add-finding-enforcement-policy, 2026-06-23)

The system SHALL deterministically detect when a *live, authoritative* artifact references a decision
that has been **superseded** or otherwise retired, and SHALL emit it as a finding with the stable code
`stale-decision-reference`. A live, authoritative artifact is an approved decision, a non-orphaned
anchored memory, or a spec requirement that names the retired decision. The finding SHALL name both the
referencing artifact and the retired target decision, and SHALL report the superseding decision when one
exists. The supersession edge that performed the retirement SHALL be exempt — a decision that supersedes
another is expected to reference the retired one and SHALL NOT itself produce this finding. Equivalently,
the synced ADR/spec block that *documents* a supersession (the block contains an immediate superseder of
the cited retired id) SHALL be exempt; a separate requirement that cites a retired decision it did not
retire SHALL still be flagged. When the supersession forms a chain (A←B←C), the reported superseding
decision SHALL be the live terminal (C), not a retired intermediate (B). The detection SHALL be a pure
walk of the decision graph and anchored references, with no LLM, and SHALL be deterministic — when two
decisions supersede the same target, the canonical superseder is the lexicographically smallest id, and
output is sorted with a locale-independent key.

> Implemented in `stale-decision-reference.ts` (`findStaleDecisionReferences`). Shares the supersession
> predicate (`isEffectiveSuperseder`) with the reversal/authoritative surfaces so the two never disagree.
> Hardened post-review (PR #190): the spec scan is block-based (the retirement record is exempt),
> supersession chains resolve to the live terminal, multi-superseder ties break deterministically, and the
> sort is locale-independent.

#### Scenario: The retirement record itself is not flagged

- **GIVEN** a synced ADR block for decision C that names the id of decision B (which C superseded), and a
  separate requirement block that still rests on B
- **WHEN** the stale-decision-reference check runs
- **THEN** the ADR block for C produces no finding, and the separate requirement block is flagged as a
  `stale-decision-reference`

#### Scenario: A live decision still cites a superseded decision

- **GIVEN** decision A (approved) whose rationale references decision B, and decision B has since been
  superseded by decision C
- **WHEN** the stale-decision-reference check runs
- **THEN** it emits one `stale-decision-reference` finding naming A as the referencing artifact, B as the
  retired target, and C as the superseding decision

#### Scenario: The superseding decision is not flagged for its own supersedes edge

- **GIVEN** decision C whose `supersedes` field points at the retired decision B
- **WHEN** the stale-decision-reference check runs
- **THEN** C's `supersedes` reference to B produces no finding

#### Scenario: A reference to a live decision is clean

- **GIVEN** an anchored memory that references decision C, which is approved and not retired
- **WHEN** the stale-decision-reference check runs
- **THEN** no `stale-decision-reference` finding is emitted for that reference

#### Scenario: An orphaned memory is not treated as authoritative

- **GIVEN** an anchored memory whose anchor symbol no longer exists (orphaned), which references a
  superseded decision
- **WHEN** the stale-decision-reference check runs
- **THEN** no `stale-decision-reference` finding is emitted, because an orphaned memory is not served as
  authoritative

### Requirement: StaleDecisionReferenceSurfacedThroughExistingTools

> Status: Implemented for `recall`, the gate, and `verify_claim` (change:
> add-finding-enforcement-policy, 2026-06-23; `verify_claim` clause completed by
> add-decision-reference-claim-verification, 2026-06-24)

The `stale-decision-reference` finding SHALL be surfaced through existing surfaces without adding a new
MCP tool: `recall` SHALL flag, in its freshness verdict, when a returned authoritative memory references
a retired decision; and the finding SHALL be contributed to the gate so it can be governed by the
enforcement policy. The finding SHALL NOT be served as a silent pass.

> `recall` attaches a `staleDecisionRef` signal to an authoritative memory whose content cites a retired
> decision and suppresses the clean `verifiedCurrent` claim; `openlore enforce` contributes the finding
> to the unified gate. The original proposal also named `verify_claim`; that clause was initially deferred
> because the structural-only claim model had no decision-reference claim to rest on. It is now closed by
> the `decision-current` claim kind (see `StructuralClaimVerification` above), which verifies the same
> retirement graph through a cleanly separated decision-store path that does not contort the structural
> verifier — so an agent can affirmatively check a decision it is *about to cite* is still authoritative,
> complementing `recall`'s passive flag on memory it happens to surface.

#### Scenario: Recall flags an authoritative memory resting on a retired decision

- **GIVEN** an authoritative anchored memory that references a superseded decision
- **WHEN** `recall` returns that memory
- **THEN** its freshness verdict carries the `stale-decision-reference` signal naming the retired target,
  rather than presenting the memory as cleanly fresh

#### Scenario: verify_claim affirmatively checks a decision an agent is about to cite

- **GIVEN** an agent about to tell a human that decision X governs a change
- **WHEN** it verifies `{ kind: 'decision-current', subject: X }` and X has been superseded
- **THEN** the verdict is `refuted`, naming the superseding decision to cite instead, so the stale citation
  is caught before it reaches the human

### Requirement: CloneQueryConclusionTool

The system SHALL expose the one-vs-all clone query through an opt-in MCP tool (`find_clones`) that
returns the **existing clones of a single query as a conclusion**, never a graph or a source dump. The
tool SHALL accept exactly one of two query forms: a `symbol` (the name, or `name::path`, of a function
already in the indexed call graph) or a `snippet` (a raw code string not necessarily in the index).
For a `symbol`, the tool SHALL extract the function's body from its persisted byte range; for a
`snippet`, it SHALL use the supplied text. It SHALL then return the ranked clone matches (each naming
file, function, optional class, line range, clone type, similarity, and source language), the
similarity floor in effect, and the number of functions compared against. Because the normalization is
language-agnostic, a match MAY be in a different language than the query (cross-language clones are out
of scope); the per-match `language` (and the query's own language, in symbol mode) SHALL be surfaced so
a consumer can distinguish a same-language reuse candidate from a cross-language coincidence.

The tool SHALL compute live from the already-persisted call graph and a re-read of the source it
spans — it SHALL NOT require a new persisted artifact and SHALL NOT introduce a schema migration. It
SHALL declare a complete input schema and return a structured conclusion, classified `conclusion` per
the MCP quality requirements. It SHALL NOT enter `MINIMAL_TOOLS`, the first-run default surface, or any
curated preset; it lands only in the full opt-in surface.

The tool SHALL be honest about what it does not know:

- a `symbol` not present in the index SHALL produce an explicit not-found result (with near-miss
  candidate names where available), never an empty match list that reads as "unique";
- an ambiguous `symbol` (matching more than one indexed function) SHALL report the ambiguity and the
  candidates rather than guessing one;
- a query below the evidence floor SHALL return a `belowThreshold` signal rather than an empty result;
- functions whose persisted byte ranges were derived from transformed source (HTML inline scripts)
  SHALL be excluded from comparison, and the exclusion SHALL be disclosed.

#### Scenario: The tool returns ranked matches, not a graph

- **GIVEN** an analyzed repository and a `symbol` that has clones
- **WHEN** an agent calls `find_clones` with that symbol
- **THEN** it receives a ranked list of the clone matches (file, function, line range, type,
  similarity) and the similarity floor in effect, and receives no node-and-edge structure to traverse

#### Scenario: Snippet mode answers the pre-write question

- **GIVEN** a code snippet the agent is about to add that closely matches an existing function
- **WHEN** an agent calls `find_clones` with that `snippet`
- **THEN** it receives the existing near-duplicate function(s) to reuse instead — an answer the
  whole-repo `get_duplicate_report` cannot give, because the snippet is not in the index

#### Scenario: A missing symbol is an explicit not-found, not "unique"

- **GIVEN** a `symbol` that does not resolve to any indexed function
- **WHEN** an agent calls `find_clones`
- **THEN** it receives an explicit not-found result (with candidate names where available), not an
  empty match list

> Change: add-clone-query-tool
> Date: 2026-06-26

### Requirement: WatcherErrorEventsNeverKillTheHost

Every filesystem watcher the MCP watcher registers — the source-tree watcher and the `.git` ref
watcher alike — SHALL have an `'error'` listener attached at registration, so an asynchronous
watcher error can never surface as an unhandled `'error'` event and terminate the long-lived host
process (the serve daemon or the stdio MCP server, neither of which installs an
`uncaughtException` handler). On a watcher error the system SHALL disclose the failure once at
debug/stderr level, release the failed watcher, and degrade to the documented fallback (batch-size
VCS-flood detection for the `.git` watcher) — continuing to serve tool calls throughout. A
post-`ready` source-watcher error, which can no longer reject the already-settled start promise,
SHALL be disclosed rather than silently swallowed.

#### Scenario: A .git watch error degrades instead of crashing

- **GIVEN** a running serve daemon whose `.git` ref watcher emits an asynchronous `'error'`
  (FD pressure, a locked `.git/index`, ref churn during a rebase)
- **WHEN** the error event fires
- **THEN** the process stays alive, a single debug-level disclosure is emitted, the failed watcher
  is released, VCS-flood detection falls back to the batch-size threshold, and subsequent file
  changes are still indexed

#### Scenario: A new watcher cannot ship without an error listener

- **GIVEN** a watcher registration in a long-lived path that attaches no `'error'` listener
- **WHEN** the error-listener coverage test runs
- **THEN** the test fails naming the uncovered registration site

> Change: harden-runtime-event-resilience
> Date: 2026-07-19

### Requirement: TraversalToolsShareOnePrecomputedRepresentation

All reachability-answering handlers (`select_tests`, `report_coverage_gaps`, `find_dead_code`,
`blast_radius`/`change_footprint`, `find_path`, `trace_execution_path`, `analyze_env_impact`, and
`verify_claim`'s reach kinds) SHALL traverse a single condensation/adjacency structure built or
loaded once per artifact generation, rather than rebuilding per-call adjacency. An unfiltered
whole-graph reach SHALL run as a topological sweep of the condensation DAG; a reach restricted to
directly-resolved edges runs an allocation-free CSR walk instead, because the condensation
describes the whole graph and a filtered graph can have strictly finer components. Every tool's
conclusion payload SHALL be unchanged: for any input, the served answer SHALL equal the answer of
the per-call BFS over the same artifact — including the ORDER-dependent parts of a payload (a
reconstructed `viaPath`, the first N paths a bounded enumeration returns), not merely the set of
results.

Establishing whether a persisted structure is current SHALL cost less than rebuilding it. A
handler that never traverses SHALL NOT pay for the structure's existence at all.

`get_subgraph` and `analyze_impact` traverse the SQLite edge store one batched query per BFS
level and never built per-call adjacency; they are therefore out of scope here, and this
requirement does not silently claim them.

#### Scenario: Answers are equivalent, only faster

- **GIVEN** a fixed analyzed graph and any `select_tests` / `find_dead_code` /
  `report_coverage_gaps` / `blast_radius` invocation
- **WHEN** the answer is served from the precomputed structure
- **THEN** it is element-for-element equal to the per-call BFS answer over the same artifact

#### Scenario: A stale structure is never served

- **GIVEN** an external `openlore analyze` that regenerated the artifacts while a daemon holds
  a loaded structure
- **WHEN** the next traversal tool call arrives
- **THEN** the daemon reloads the structure for the new generation before answering (same
  invalidation the context cache uses), never serving a traversal over the old graph

#### Scenario: Repeated conclusions over one graph pay the build once

- **GIVEN** a caller that computes many footprints over one graph in a single call
  (`plan_parallel_work`, `map_in_flight_conflicts`)
- **WHEN** each footprint's backward reachability runs
- **THEN** they share one structure for that graph rather than rebuilding adjacency per task

### Requirement: AutoApprovedProvenanceIsAlwaysDisclosed

`recall` and `verify_claim` (`decision-current`) SHALL treat `auto-approved` decisions as
authoritative but SHALL carry their provenance (`approvedBy: autopilot`, acceptance
timestamp) in the response, so an agent citing the decision can disclose that it was
machine-accepted and unreviewed. Spec rendering of an auto-approved decision SHALL carry an
explicit "auto-accepted (unreviewed)" marker. A decision promoted by a human loses the
marker; provenance SHALL never be silently upgraded.

#### Scenario: Citing an auto-accepted decision honestly

- **GIVEN** an `auto-approved` decision governing a file the agent is changing
- **WHEN** the agent calls `verify_claim` with kind `decision-current` for it
- **THEN** the verdict is `verified` (it is the live authority) and the receipt includes
  `approvedBy: autopilot`, enabling the agent to disclose the provenance to the human

### Requirement: ConclusionsDiscloseParseHealthBoundaries

A conclusion tool whose result depends on extraction from a file with a degraded parse-health
record (ERROR/MISSING regions, parse failure, or encoding fallback) SHALL append a boundary
disclosure identifying the file and the degradation, so a smaller-than-real result reads as a lower
bound rather than verified absence. `get_language_support`, `orient`, and `doctor` SHALL surface a
compact parse-health summary (per-language counts / degraded-file lists) for the analyzed scope. A
repository with no degraded files SHALL incur no boundary output and no payload growth. Parse-health
regressions SHALL be expressible as the registered governance finding `parse-health` (advisory by
default; enforcement class owned by the operator's `enforcement.policy`).

#### Scenario: Dead-code over a degraded file carries a boundary

- **GIVEN** `find_dead_code` whose reachability set touches a file that parsed with ERROR regions
- **WHEN** the tool returns candidates
- **THEN** the response disclosed that symbols and edges in that file are a lower bound

#### Scenario: Clean repositories pay nothing

- **GIVEN** a repository whose files all parse cleanly
- **WHEN** any conclusion tool runs
- **THEN** no parse-health boundary appears and response size is unchanged

#### Scenario: An operator gates on parse-health regressions

- **GIVEN** an `enforcement.policy` classing `parse-health` as `blocking`
- **WHEN** `openlore enforce` runs after a grammar upgrade that degraded 40 files
- **THEN** the gate blocks with the finding's evidence (file counts, spans)

### Requirement: SymbolSpanLocatorReportsFreshnessVerdict

The `locate_symbol_span` tool SHALL be read-only (`readOnlyHint: true`) and SHALL NOT write, move,
or delete any file. It SHALL resolve its target through the same `name::path` addressing used by
`find_clones` and SHALL refuse to guess: an unknown symbol returns `not-found` with candidates; an
ambiguous bare name returns `ambiguous` with the `name::path` candidate list. For a resolved
symbol it SHALL return the byte-exact and line span plus a freshness verdict derived from comparing
the indexed span's content hash against the file's current bytes: `fresh` when they match (the span
is safe to edit at exactly these offsets), or `stale` with a re-analyze hint and no usable offset
when they differ (the index is behind the working tree). The tool SHALL NOT itself apply an edit —
it hands the host a location the substrate can vouch for; the host applies the write with its own
tool.

#### Scenario: An ambiguous symbol returns candidates, not a location

- **GIVEN** two indexed functions named `process` in different files and a call targeting bare
  `process`
- **WHEN** `locate_symbol_span` runs
- **THEN** the verdict is `ambiguous` and both `process::<path>` candidates are listed
- **AND** no span is returned

#### Scenario: A stale span is disclosed, never served as trustworthy

- **GIVEN** a symbol whose file changed after the last analysis (indexed span hash ≠ current
  content)
- **WHEN** `locate_symbol_span` targets it
- **THEN** the verdict is `stale` with a re-analyze hint
- **AND** no usable offset is presented as current

#### Scenario: A fresh span returns the byte-exact edit location

- **GIVEN** an unambiguous `name::path` symbol whose span hash matches current content
- **WHEN** `locate_symbol_span` runs
- **THEN** the verdict is `fresh` and the result carries the byte and line span plus the content
  hash
- **AND** no file is modified (the host performs any edit)

### Requirement: LeaseWeightTableIsComplete

The epistemic lease's cognitive-load weight table (`TOOL_WEIGHTS`) SHALL cover every tool
registered in `TOOL_DEFINITIONS`, and SHALL contain no entry for a tool that is no longer
registered. Completeness SHALL be enforced by a CI test cross-checking the table against the live
registry in both directions — the same closed-table discipline applied to `TOOL_OUTPUT_CLASS` and
`TOOL_CAPABILITY_FAMILY` — so a newly added tool without a declared weight fails CI rather than
silently falling to the minimum-weight fallback. A new tool's weight SHALL be assigned by analogy
to its nearest existing entry in the same traversal-depth class (lightweight read, structural
read, graph traversal, deep architectural trace), never as a newly invented constant; tools
documented as near-twins (e.g. `find_path` and `trace_execution_path`) SHALL carry the same
weight. The runtime fallback for an unknown name MAY remain as defense in depth, but SHALL never
be the mechanism by which a registered tool is scored.

#### Scenario: A new tool without a weight fails CI

- **GIVEN** a change that registers a new tool in `TOOL_DEFINITIONS` without adding a
  `TOOL_WEIGHTS` entry
- **WHEN** the completeness test runs
- **THEN** it fails, naming the unweighted tool
- **AND** the failure is independent of whether the runtime fallback would have produced a value

#### Scenario: A stale weight entry fails CI

- **GIVEN** a tool removed from (or renamed in) `TOOL_DEFINITIONS` whose old name remains in
  `TOOL_WEIGHTS`
- **WHEN** the completeness test runs
- **THEN** it fails, naming the stale entry

#### Scenario: Near-twin tools accrue equal load

- **GIVEN** two tools documented as answering the same class of question at the same traversal
  depth (e.g. `find_path` and `trace_execution_path`)
- **WHEN** each is invoked once in a session
- **THEN** each contributes the same weight to the session's cognitive load

#### Scenario: Load accounting reflects actual work on the default surface

- **GIVEN** a session invoking only default-surface tools, including graph traversals
  (`find_path`, `blast_radius`) and lightweight reads (`recall`)
- **WHEN** the lease accumulates cognitive load
- **THEN** the traversals contribute their declared structural/architectural weights, not the
  minimum fallback, so degrade/stale thresholds fire when the declared tier model says they should

### Requirement: StructuralDiffReadsOldContentAtTheMergeBase

The system SHALL read a structural diff's OLD file content from the same git point its
changed-file list is scoped to: for the working-tree comparison, the merge-base of the resolved
base ref and HEAD; for an explicit two-ref comparison, the merge-base of the resolved base ref and
the head ref (with three-dot file-list semantics). When no common ancestor exists, the system
SHALL fall back to the resolved ref's tip, mirroring the file-list fallback. Every downstream
consumer of the old snapshot — signature changes, stale callers, and the realized write-footprint
used for footprint-escape detection — SHALL therefore attribute only branch-side edits to the
change, never drift the base branch accrued after the branch point. A snapshot whose graph build
fails SHALL be disclosed as a parse-failure boundary in the response, never silently compared as
an empty graph.

#### Scenario: An advanced base does not misattribute main-side edits

- **GIVEN** a branch whose base ref has advanced past the branch point
- **AND** a file changed on both the branch and the base since the branch point
- **WHEN** `structural_diff` runs the working-tree comparison
- **THEN** the delta contains only branch-side changes
- **AND** a function added on the base after the branch point is not reported as removed

#### Scenario: Footprint-escape findings rest on the branch's own writes

- **GIVEN** the same advanced-base repository and an opt-in `declaredFootprint`
- **WHEN** `structural_diff` computes the realized write-footprint
- **THEN** base-side edits produce no out-of-scope-write or removed-symbol escape
- **AND** no footprint-escape governance finding is emitted for them

#### Scenario: The explicit two-ref path uses merge-base semantics

- **GIVEN** `structural_diff` called with a `baseRef` whose tip is ahead of the `headRef` branch point
- **WHEN** the two-ref comparison runs
- **THEN** files changed only on the base side are excluded from the delta
- **AND** old content is read at the merge-base of the two refs

#### Scenario: A snapshot build crash is a disclosed boundary

- **GIVEN** a changed file whose snapshot graph build throws
- **WHEN** `structural_diff` returns
- **THEN** the response names the failed snapshot in its soundness caveats
- **AND** the delta is not presented as an authoritative all-added or all-removed comparison

### Requirement: RegisteredRepoFreshnessIsBaselined

A federation registry entry whose stored fingerprint is empty (a repo registered before its first
`openlore analyze`) SHALL NOT be reported as plain `indexed`: until a fingerprint baseline exists,
its state SHALL be an explicit `unbaselined` disclosure stating that staleness cannot yet be
assessed, with remediation. When a federation status or consult path observes a live index
fingerprint for such an entry, it SHALL adopt that fingerprint as the stored baseline (persisted
through the existing atomic registry write), so that subsequent drift is detected as `stale`. The
staleness verdicts for entries that already carry a baseline SHALL be unchanged. No entry SHALL be
able to report `indexed` indefinitely while its index drifts.

#### Scenario: A pre-analyze registration is disclosed, then baselined

- **GIVEN** a repo registered into the federation before its first `openlore analyze` (stored
  fingerprint empty)
- **WHEN** the repo's index is later built and `federation_status` runs
- **THEN** the entry is reported `unbaselined` (or the live hash is adopted in the same call and
  the adoption disclosed) — never plain `indexed` with an empty baseline
- **AND** after adoption, a subsequent index change is reported `stale`

#### Scenario: Adoption requires a live index

- **GIVEN** an empty-fingerprint entry whose repo has no built index
- **WHEN** a status path evaluates it
- **THEN** the state remains `unindexed` and no baseline is written

#### Scenario: spec_store_status inherits the honest state

- **GIVEN** a spec-store target bound to an unbaselined federation entry
- **WHEN** `spec_store_status` resolves the target
- **THEN** the target's status discloses the unbaselined condition rather than implying a
  freshness-checked `indexed` state

### Requirement: FederationStatusDegradesToConclusion

`federation_status` SHALL degrade an unreadable or malformed federation registry
(`.openlore/federation.json`) to a conclusion-shaped result — naming the file, the parse or shape
error, and the remediation — rather than propagating a raw exception to the transport. The
degradation SHALL match the shape its sibling `spec_store_status` already returns for the
identical failure (`registry-unreadable`).

#### Scenario: A corrupt registry yields a finding, not a throw

- **GIVEN** a `.openlore/federation.json` containing invalid JSON or an unexpected shape
- **WHEN** `federation_status` is called
- **THEN** the tool returns a conclusion identifying the registry as unreadable, with the file
  path and a remediation step (fix or delete the file)
- **AND** no raw exception reaches the MCP transport

### Requirement: BackgroundConsolidationFailsClosed

A background process spawned by a long-lived MCP handler (e.g. the decision consolidator fired by
`record_decision`) SHALL never be able to crash the host server: every spawn SHALL register an
error listener, and a spawn failure (ENOENT, EACCES, or any pre-exec error) SHALL be contained and
reported. The tool response SHALL reflect the actual spawn outcome — a handler SHALL NOT claim
background work is running when the spawn failed; a failed spawn SHALL be disclosed together with
the manual recovery command. Concurrent spawn requests SHALL be coalesced against the existing
consolidation lock (reused as the in-flight sentinel — no new locking mechanism): while a run is
in flight no additional consolidator is spawned, and the response discloses that the work was
coalesced. The primary write (the recorded decision) SHALL commit independently of the background
spawn's outcome.

#### Scenario: The consolidator binary is missing

- **GIVEN** an environment where binary resolution falls through to a bare `openlore` that is not
  on PATH
- **WHEN** `record_decision` fires the background consolidation and the spawn emits ENOENT
- **THEN** the MCP server process survives (no uncaught exception)
- **AND** the decision itself is recorded and its id returned
- **AND** the response states consolidation could not be started and names
  `openlore decisions --consolidate` as the recovery step, instead of claiming it is running

#### Scenario: A successful spawn is reported as started

- **GIVEN** a resolvable consolidator binary
- **WHEN** `record_decision` fires the background consolidation and the child emits `spawn`
- **THEN** the response reports consolidation running in the background, as today

#### Scenario: Rapid records coalesce onto one consolidator

- **GIVEN** a consolidation run already in flight (its lock held)
- **WHEN** a second `record_decision` arrives before the run completes
- **THEN** no second consolidator process is spawned
- **AND** the response disclosed that consolidation was coalesced onto the in-flight run

### Requirement: DecisionStatusPromotionIsCasChecked

Every mutation of a decision's status SHALL be committed through the compare-and-swap store update
(`updateDecisionStore`) and verified after commit, following the patch-then-verify shape of
`approve_decision`/`reject_decision`. No handler SHALL promote a decision's status on a
locally-loaded copy of the store and act on that copy outside the CAS path. A promotion whose
post-commit verification shows the decision was concurrently removed or changed SHALL return an
honest error rather than a false success, and SHALL never clobber decisions recorded concurrently.

#### Scenario: sync_decisions promotes an id under CAS

- **GIVEN** a draft decision and a `sync_decisions` call naming its id
- **WHEN** the handler promotes the decision to `approved` before syncing
- **THEN** the promotion is committed via `updateDecisionStore` and re-verified on the committed
  store, not applied to a locally-loaded copy

#### Scenario: A concurrent draft survives a sync

- **GIVEN** a `sync_decisions` call in progress and a `record_decision` committing a new draft
  concurrently
- **WHEN** both operations complete
- **THEN** the new draft is present in the store (the CAS merge re-applied it)
- **AND** the synced decision's status reflects the sync

#### Scenario: A concurrently-removed decision yields an honest error

- **GIVEN** a decision removed between load and promotion
- **WHEN** the promotion's post-commit verification runs
- **THEN** the handler returns an error naming the id, not a success claiming it was synced

### Requirement: DecisionStatusTransitionsAreGuarded

Decision status changes SHALL be governed by an explicit transition table over the existing status
vocabulary (`draft`, `consolidated`, `verified`, `phantom`, `approved`, `rejected`, `synced`). A
handler SHALL NOT change a decision's status without first checking that the transition from its
current status is legal. In particular: a `rejected` decision SHALL NOT be promoted to `approved`
as a side-effect of any other operation — `sync_decisions` with an explicit `id` SHALL refuse the
promotion with an error naming the current status and the required human step; reversing a
rejection SHALL require an explicit `approve_decision` carrying human authorization, and that path
SHALL disclose that a recorded rejection is being reversed. An already-`synced` decision SHALL NOT
be re-promoted. Illegal transitions SHALL leave the store and the spec files unchanged. This
requirement governs which transitions are legal; the compare-and-swap commit discipline for legal
transitions is governed separately (`DecisionStatusPromotionIsCasChecked`,
change `harden-decision-consolidation`).

#### Scenario: sync_decisions cannot resurrect a rejected decision

- **GIVEN** a decision a human rejected via `reject_decision`
- **WHEN** `sync_decisions` is called with that decision's `id`
- **THEN** the handler returns an error naming the decision's `rejected` status and the explicit
  `approve_decision` step required to reverse it
- **AND** the decision's status is unchanged and no spec file is written

#### Scenario: approve_decision discloses a rejection reversal

- **GIVEN** a `rejected` decision with a review note
- **WHEN** `approve_decision` is called with its `id`
- **THEN** the handler refuses (or requires the explicit reversal path per the transition table),
  surfacing the prior rejection and its note so the agent presents the reversal to the human
  rather than silently overriding a recorded verdict

#### Scenario: The legal lifecycle is unchanged

- **GIVEN** a `verified` decision
- **WHEN** a human approves it via `approve_decision` and it is then synced via `sync_decisions`
- **THEN** the decision moves `verified → approved → synced` exactly as before, with no new
  friction on legal transitions

### Requirement: StalenessTriggersBackgroundRepair

Every read-path staleness signal that yields a verdict — integrity `mismatched`, a stale
region above threshold, a schema reset, or analysis age beyond the doctor warning threshold
— SHALL additionally trigger the shared at-most-once background repair service (the
generalized cold-start bootstrap: non-blocking, never-throw, opt-out via
`OPENLORE_NO_AUTO_ANALYZE` / `autoInit: false`). A repair that completes and still observes
its trigger SHALL disclose and stop, never loop. Detection and disclosure are unchanged;
repair is additive.

#### Scenario: A stale index heals itself behind an honest answer

- **GIVEN** a repo whose index attestation reconciles to `mismatched`
- **WHEN** any graph-dependent tool is called
- **THEN** the response is served with the existing staleness verdict plus a
  "background refresh started" note, exactly one background `analyze` starts, and a later
  call after it completes serves fresh results with no verdict

#### Scenario: Repair never blocks or lies

- **GIVEN** a background repair in flight
- **WHEN** further tool calls arrive
- **THEN** each returns without waiting on the rebuild and none presents the in-repair
  index as fresh

> Note: the next requirement was originally a MODIFIED block. Its base requirement was
> authored in `refine-happy-path-and-defaults`, which shipped without spec deltas, so the
> full statement is recorded here as an addition.

### Requirement: ReadyOrHonestFirstUse

A tool invoked against a directory with no index SHALL self-bootstrap the analysis in the
background and answer with a machine-readable not-ready shape (never stdout noise on stdio).
The not-ready/staleness conclusion SHALL additionally distinguish *repairing* from *absent*
and *stale*: when the background repair service has been triggered for the queried
directory, the conclusion carries the repair-in-progress marker and its trigger reason, so
an agent can decide to proceed on the disclosed-stale answer or retry.

#### Scenario: Absent vs stale vs repairing are distinguishable

- **GIVEN** three repos: no index, a stale index with repair running, and a fresh index
- **WHEN** the same tool is called against each
- **THEN** the responses respectively carry `reason: index-absent`, the staleness verdict
  with a repair-in-progress marker and reason, and no freshness caveat at all

### Requirement: PriorChurnIsMeasuredBeforeTheBriefedRange

The system SHALL compute `briefing_since`'s prior-churn evidence — `priorChurn`, its
`volatilityLevel`, and the `historyAvailable` predicate that gates the `surprising-change` tier —
exclusively over commits at or before the briefing's resolved base ref, never over commits inside
the briefed range itself. A symbol's significance within the briefed range SHALL NOT be able to
demote its own surprise tier.

#### Scenario: A dormant hub hammered in the briefed range is surprising

- **GIVEN** a hub whose file was untouched for hundreds of commits before the base ref
- **AND** many commits touching it within the briefed range
- **WHEN** `briefing_since` ranks the change set
- **THEN** the symbol's prior churn reflects only pre-base commits
- **AND** the `surprising-change` tier is assigned

#### Scenario: A history that is entirely the briefed range has no "before"

- **GIVEN** a repository whose full commit history lies within the briefed range
- **WHEN** `briefing_since` evaluates history availability
- **THEN** `historyAvailable` is false
- **AND** the surprise label is withheld with the shallow-history receipt

#### Scenario: Other churn consumers are unchanged

- **GIVEN** a caller of the change-coupling miner that supplies no start ref
- **WHEN** churn is mined
- **THEN** the result is identical to the pre-change behavior

### Requirement: BriefingCapabilityClaimsAreCurrent

The system SHALL NOT embed in any tool response a claim that a shipped capability does not exist.
`blast_radius`'s federation block SHALL either evaluate cross-repo impact by forwarding the
opt-in federation scope to its composed test selection, or state truthfully that this tool does
not evaluate it and name the tool that does — never that the capability is "not yet shipped".

#### Scenario: The default-surface briefing tells the truth about federation

- **GIVEN** `blast_radius` on the default preset
- **WHEN** the briefing is returned
- **THEN** its federation block contains no claim that multi-repo federation is unshipped
- **AND** it either carries an evaluated result or names `select_tests` with `federation: true`

#### Scenario: Forwarded federation reaches the composed selection

- **GIVEN** the implementation forwards a federation option
- **WHEN** `blast_radius` is called with federation opted in
- **THEN** the composed test selection runs with the federation scope
- **AND** the briefing carries its cross-repo result and coverage disclosures

### Requirement: RecordedDecisionsDeclareContentOrigin

The `record_decision` handler SHALL mark agent-authored drafts as `agent-recorded`, and
decision-list responses SHALL expose the explicit origin for every pending decision.

#### Scenario: Agent-recorded text is distinguishable from LLM text

- **GIVEN** an agent records an architectural decision through MCP
- **WHEN** a reviewer lists the pending decisions
- **THEN** the decision reports `agent-recorded` rather than an absent or inferred origin

### Requirement: EmptyOrientationsExplainThemselves

An `orient` result with no relevant functions SHALL carry a deterministic empty-result
disclosure: the identifier-shaped query tokens that matched nothing in the corpus, and, for each,
any indexed identifier token that shares a prefix or substring relation with the missed token
(either token may contain the other), as a "near token" receipt. The lookup SHALL be bounded over
the existing corpus vocabulary and use no model or new index. The disclosure SHALL state facts
about the miss, never guess an answer.

#### Scenario: A morphological miss names its near token

- **GIVEN** a keyword-mode index whose only matching identifier is `greet`
- **WHEN** `orient` runs for the task "change the greeting"
- **THEN** the empty payload discloses that `greeting` matched nothing and that `greet` is an
  indexed near token

#### Scenario: A genuinely foreign query discloses the miss without a near token

- **GIVEN** the same index
- **WHEN** `orient` runs for "kubernetes ingress rules"
- **THEN** the payload discloses the missed tokens and contains no fabricated near token

### Requirement: NextStepsAreConditionedOnResultShape

The `nextSteps` (and equivalent guidance fields) of an orientation SHALL be conditioned on the
result's shape. An empty briefing SHALL suggest actions appropriate to a miss — an identifier-
style `search_code`, `get_map`, and the near-token receipt when present — and SHALL NOT carry
implement-then-verify workflow steps that presuppose results. A populated briefing keeps the
existing guidance.

#### Scenario: An empty briefing does not advise recording decisions

- **GIVEN** an orient call that matches nothing
- **WHEN** the payload is served
- **THEN** `nextSteps` contains miss-appropriate suggestions and does not contain the
  record_decision / check_spec_drift boilerplate

### Requirement: UserFacingFunctionCountsAgree

Every user-facing count of indexed functions (the analyze/install epilogue's "Function index
built (N functions)") SHALL agree with the call-graph function count for the same analysis, or
SHALL state exactly what else it includes. Two counts of the same population in one output SHALL
NOT silently differ.

#### Scenario: The epilogue counts match

- **GIVEN** a repository whose call graph contains 5 functions
- **WHEN** install's index build completes
- **THEN** the function-index message reports 5, or explicitly names the additional entries it
  counted

### Requirement: ConclusionsDiscloseWhenTheIndexIsBehindTheWorkingTree

Before serving, the cold-navigation conclusion handlers `orient`, `search_code`, `get_subgraph`,
and `blast_radius` SHALL compare the bounded set of source files cited by their final payload —
and only those files — against the analysis artifact's recorded baseline (modification time
first, content hash to confirm, reusing the span-locator's dual-baseline mechanic through a
shared helper). When any checked file has changed since the baseline, the payload SHALL carry a
factual staleness note naming the changed files and stating that results may omit recent edits.
If a payload contains more citations than the bounded check can inspect, it SHALL instead carry
an explicit unchecked-citations boundary and SHALL NOT imply the omitted citations are current.
The conclusion SHALL still be served (fail-open); the check SHALL NOT scan beyond the cited
files; a repository where every cited file was checked and matches the baseline SHALL produce
no note and no per-call cost beyond the bounded stat/hash of cited files.

#### Scenario: A cold-started server serves a stale graph with disclosure

- **GIVEN** a repository analyzed at commit X, then edited on disk (a new function appended to
  `src/payments.ts`) with no re-analyze
- **WHEN** a freshly started MCP server receives `orient` for a task matching that file
- **THEN** the payload includes a staleness note naming `src/payments.ts`, and the structural
  results are otherwise served as today

#### Scenario: A fresh index stays silent

- **GIVEN** a repository whose working tree matches the analysis baseline
- **WHEN** any of the four cold-navigation conclusion tools runs
- **THEN** no staleness note appears in the payload

### Requirement: DetectedColdStalenessFeedsTheRepairPathWhereOneIsWired

When a read-time staleness detection occurs in a host that has a repair path (an in-process
watcher under `--watch-auto`, or a serve daemon), the changed files SHALL be handed to the
existing stale-region/self-rebuild machinery, and the staleness note SHALL state that repair has
been scheduled. In a host with no repair path (a one-shot CLI invocation), the note SHALL
disclose only; it SHALL NOT spawn analysis work from a read.

#### Scenario: Watcher-hosted detection schedules repair

- **GIVEN** the cold-started server above running with `--watch-auto`
- **WHEN** the stale read is detected
- **THEN** the note states repair is scheduled, and a subsequent orient after convergence
  reflects the edit with no staleness note

### Requirement: DaemonServesOnlyItsServedRoot

The HTTP daemon SHALL confine tool requests to the root it was started for: a request whose
resolved directory is not the served root is rejected with an error naming the served root and
the remedy (start a daemon for that root), before any context is parsed or store handle opened.
Consequently the daemon's per-directory caches (parsed context, open EdgeStore handles,
schema-reset flags) hold entries only for the served root and cannot be grown without bound by
client-supplied directories. Confinement is chosen over an eviction policy because clients
discover a daemon through that root's descriptor — cross-root requests indicate misuse or probing
— and because it removes both the resource-growth and the trust hazard with no new tuning
constant. The in-process (non-daemon) MCP server path is unchanged. Telemetry emitted by handlers
SHALL relativize absolute filesystem paths in error/module fields (project-relative, or `~` for
home) — telemetry remains opt-in and is never transmitted off the machine.

#### Scenario: A foreign directory is rejected, not cached

- **GIVEN** a daemon serving root `R` and a local client naming directory `Q` outside `R`
- **WHEN** the request is handled
- **THEN** it is rejected with an error naming `R` and how to serve `Q`, and no context cache
  entry or store handle for `Q` is created

#### Scenario: The daemon's memory does not grow with hostile directory churn

- **GIVEN** a long-lived daemon receiving requests naming many distinct existing directories
- **WHEN** the requests are processed
- **THEN** the context cache and open-handle count remain bounded to the served root

#### Scenario: Telemetry error fields carry no absolute paths

- **GIVEN** a tool error whose message embeds an absolute path under the user's home
- **WHEN** the telemetry event is written
- **THEN** the recorded field is relativized (project-relative or `~`-prefixed), and credentials
  redaction continues to apply

### Requirement: SearchDisclosesDegradedVectorIndex

The `search_code` and `suggest_insertion_points` handlers SHALL include an optional
`indexDegraded` string when the vector index records, or the live process observes, an incremental
update whose add and rollback both failed. The disclosure SHALL use the remediation
`Index degraded — re-run "openlore analyze".` and SHALL remain present on normal and literal-text
fallback results until a successful full rebuild establishes a healthy index. Healthy responses
SHALL omit the field.

#### Scenario: Search result carries persisted degradation

- **GIVEN** an incremental vector-index update whose add and rollback both failed
- **WHEN** `search_code` or `suggest_insertion_points` serves a result
- **THEN** the response includes `indexDegraded` with the full-rebuild remediation

#### Scenario: Literal fallback does not hide degradation

- **GIVEN** a degraded vector index and a symbol query with no symbol matches
- **WHEN** `search_code` returns literal-text fallback matches
- **THEN** the fallback response still includes `indexDegraded`

#### Scenario: Healthy search omits the warning

- **GIVEN** a successful full vector-index rebuild with no degraded marker
- **WHEN** either search handler serves a result
- **THEN** the response omits `indexDegraded`

### Requirement: SeedTestCoverageIsIdentityKeyed

The system SHALL decide whether a changed seed symbol has a reaching test by the identity of the
nodes the backward walk actually reached (node id, or at minimum file plus name), never by bare
name membership in any selected test's path. A seed with no reaching test SHALL always receive
the same-file sibling fallback and its low-confidence disclosure caveat, even when another symbol
of the same name elsewhere in the graph is reached by tests.

#### Scenario: A same-named function elsewhere does not shadow an untested seed

- **GIVEN** two functions named `render` in different files, where tests reach only the first
- **WHEN** `select_tests` runs with the second file's `render` as a changed seed
- **THEN** the seed is treated as having no reaching test
- **AND** its same-file sibling tests are selected at low confidence with the fallback caveat

#### Scenario: A genuinely covered seed does not trigger the fallback

- **GIVEN** a seed that the backward walk reaches from at least one test
- **WHEN** the fallback predicate is evaluated
- **THEN** the same-file fallback does not fire for that seed

### Requirement: TestSelectionBoundsAreDisclosed

The system SHALL disclose every bound that narrowed or widened a test selection. When the
backward reachability walk stops at its depth cap while its frontier is non-empty, the response
SHALL carry a truncation receipt naming the depth, and any "may be genuinely untested" conclusion
SHALL be qualified by it. When a changed-symbol seed resolved via the substring fallback rather
than an exact name match, the response SHALL carry the same widening caveat its sibling
`report_coverage_gaps` emits, naming a bounded sample of the widened symbols and pointing to the
complete seed list. Empty changed-symbol names MUST be rejected rather than widening to every
production symbol. Composed consumers (such as
`blast_radius`) SHALL surface these receipts unmodified.

#### Scenario: Truncated reachability carries a receipt

- **GIVEN** a test whose only path to the changed seed exceeds the depth cap
- **WHEN** `select_tests` returns
- **THEN** the response includes a truncation field naming the cap depth
- **AND** the untested-seed caveat is qualified by the truncation

#### Scenario: An exhausted walk carries no truncation receipt

- **GIVEN** a backward walk whose frontier empties before the depth cap
- **WHEN** `select_tests` returns
- **THEN** no truncation receipt is present

#### Scenario: Substring seed widening is disclosed

- **GIVEN** a short changed-symbol name that matches no function exactly
- **WHEN** the seed set is resolved by the substring fallback
- **THEN** the response caveats that the symbol scope may have widened, naming the symbols

#### Scenario: Receipts survive composition

- **GIVEN** `blast_radius` composing a truncated or substring-widened selection
- **WHEN** the briefing is assembled
- **THEN** the truncation and widening receipts appear in the briefing's test section

#### Scenario: Empty symbols do not widen to the whole graph

- **GIVEN** a changed-symbol list containing an empty name
- **WHEN** test selection resolves the requested scope
- **THEN** the request is rejected with an actionable error instead of selecting every symbol

### Requirement: InFlightAssessmentFailuresAreDisclosed

The system SHALL represent every in-flight change it enumerated but could not structurally assess
as a clearly-labeled not-assessed node — for branches exactly as for pull requests — naming the
failed operation (merge-base, tip resolution, or diff) in the node's detail. An in-flight change
SHALL never be silently omitted from the map because a git or gh invocation failed. When the base
ref for a repository could not be verified, the map SHALL carry a caveat naming that base rather
than letting every dependent merge-base fail silently; when pull-request enumeration hits its
listing limit, the map SHALL disclose possible truncation.
When a fetched diff exceeds the bounded per-change file budget, the change SHALL remain visible as
not assessed with reason `assessment-capped`, naming both the observed file count and the cap.

#### Scenario: A branch whose merge-base fails is not assessed, not absent

- **GIVEN** a local branch for which `git merge-base` fails (e.g. a shallow clone)
- **WHEN** `map_in_flight_conflicts` runs
- **THEN** the branch appears as a not-assessed node with reason `diff-unfetchable`
- **AND** the detail names the failed git operation

#### Scenario: A CI gate cannot pass on silently missing branches

- **GIVEN** a repository where every branch's diff is unfetchable
- **WHEN** a caller gates on `cross-actor-conflict` findings
- **THEN** the map reports the branches as not assessed rather than reporting "no conflicts"

#### Scenario: An unverifiable base ref is a caveat, not a silent wipeout

- **GIVEN** a base ref that does not resolve in the assessed repository
- **WHEN** the map is built
- **THEN** a caveat names the unverifiable base
- **AND** branches are not dropped without their own not-assessed nodes

#### Scenario: PR enumeration truncation is disclosed

- **GIVEN** a repository with more open pull requests than the enumeration limit
- **WHEN** pull requests are enumerated
- **THEN** the map carries a caveat that the open-PR list may be truncated

#### Scenario: An oversized diff is not partially cleared

- **GIVEN** an in-flight change whose diff exceeds the per-change file assessment cap
- **WHEN** the interference map is built
- **THEN** the change appears as not assessed with reason `assessment-capped`
- **AND** the detail names the observed file count and the cap

### Requirement: ReadOnlyOverlapIsNotAConflict

The system SHALL NOT classify two footprints as a WAR hazard when their write-sets share no file:
pure read-intersection between two changes is not a data hazard and SHALL never contribute to the
map's conflict count nor render a message implying the changes touch the same file. WAR SHALL be
reserved for write-sets touching the same file at disjoint symbols. If read-only overlap is
surfaced at all, it SHALL be a distinct lowest-tier advisory whose message states that both
changes read the shared symbols and that no write conflict exists.

#### Scenario: Disjoint writers sharing a read are not a WAR pair

- **GIVEN** two changes with disjoint write-sets whose read closures share one symbol
- **WHEN** the hazard between them is classified
- **THEN** the verdict is not WAR
- **AND** the pair does not increment the map's conflict count

#### Scenario: Same-file disjoint-symbol writes remain WAR

- **GIVEN** two changes that write different symbols in the same file
- **WHEN** the hazard is classified
- **THEN** the verdict is WAR with the shared file as witness

### Requirement: ConclusionsCarrySpanEvidence

Symbol-level conclusion entries SHALL carry the span evidence the graph already stores:
`search_code` symbol hits and `orient` function entries SHALL include the symbol's start line,
joined by canonical symbol id. `analyze_impact` SHALL select affected entries by canonical order
within a global response cap and include a `callSites` collection containing every stored
call-site line on qualifying shortest-frontier edges that place each selected entry at its
reported depth. A top-level `callSiteEvidenceReceipt` SHALL disclose the eligible, returned, and
omitted entry counts and whether the global cap truncated evidence. Every non-terminal `trace_execution_path` step SHALL
include a `callsNext` collection containing every stored call-site line on parallel edges from
that step's symbol to the next symbol. Each receipt SHALL identify its caller so distinct
same-file, same-line edges remain distinguishable. These collections SHALL be deterministically ordered,
SHALL deduplicate identical receipts, and SHALL be response- and computation-bounded. The receipt
SHALL expose `returned`, exact `total` when complete or bounded `totalAtLeast` when truncated,
and `truncated`; it MUST NOT retain unbounded uniqueness state merely to compute an exact total. Surfaced lines SHALL come
from stored structural facts only — never inferred or approximated. A missing stored line SHALL
remain absent, and stale-index line freshness SHALL be disclosed using the established
content-hash-first, artifact-mtime-fallback dual-baseline verdict rather than presented as current.

#### Scenario: A trace names the exact call sites

- **GIVEN** a `trace_execution_path` result from A to C via B and two stored parallel A→B call
  edges at distinct lines
- **WHEN** the path is returned
- **THEN** A's `callsNext` contains both stored lines in deterministic order, B's `callsNext`
  contains every stored B→C line, and C has no `callsNext`

#### Scenario: Impact preserves every shortest-frontier receipt

- **GIVEN** an affected symbol within the global evidence cap is reached at the same shortest depth from two prior-depth callers
- **WHEN** `analyze_impact` returns that affected entry
- **THEN** its `callSites` contains every stored qualifying edge receipt from both callers rather
  than one arbitrarily selected line

#### Scenario: Lines are facts, not guesses

- **GIVEN** an edge whose call-site line was not captured at extraction
- **WHEN** its step is returned
- **THEN** no receipt is fabricated for that edge — the line is never estimated from the
  callee's span or any other heuristic

### Requirement: SliceFocusDisclosesPrecisionAndScope

`get_function_body` SHALL accept optional focused reads using `focus` plus an explicit
`focusKind: variable | callee`. A successful focused response SHALL omit the full `body` and
SHALL return bounded, deterministically ordered stored line receipts with source text and an
explicit completeness/truncation receipt. A `variable` focus SHALL return persisted direct
definition/use evidence for the same display spelling within the selected function, with roles
and the stored `dataFlowPrecision: exact | may`; the response SHALL disclose that variable
spellings are not scope-qualified, and `may` SHALL never be collapsed into `exact`. A `callee`
focus SHALL return every stored parallel call-site receipt whose raw callee name matches, with
the edge's stored `callConfidence`; it SHALL NOT fabricate a data-flow precision label for call
evidence. Calls that omit `focus` and `focusKind` SHALL preserve the legacy response byte-for-byte.

A variable focus outside CFG-overlay language support or without a usable overlay SHALL return
the legacy whole body with a machine-readable `sliceUnavailable` reason. An unknown focus SHALL
return a typed not-found result with bounded candidates. An ambiguous symbol, stale or mixed
analysis generation, unreadable source, or stored line outside the selected symbol span SHALL
fail closed with a machine-readable refusal and no focused body. Symbol resolution, freshness,
and line evidence SHALL come from one cached analysis generation.

#### Scenario: A focused read costs the slice, not the body

- **GIVEN** a 300-line function and `focusKind: variable` for a spelling with 6 persisted direct
  definition/use evidence lines
- **WHEN** `get_function_body` runs with that focus
- **THEN** the response contains those 6 lines with their source text, roles, and unchanged
  `dataFlowPrecision` values, an explicit completeness receipt, and no `body`

#### Scenario: Callee focus does not invent data-flow precision

- **GIVEN** a function with two stored call edges whose raw callee name matches the requested
  `focusKind: callee`
- **WHEN** `get_function_body` runs with that focus
- **THEN** both line receipts carry their stored `callConfidence`, neither carries
  `dataFlowPrecision`, and the response contains no full `body`

#### Scenario: An unsupported language degrades honestly

- **GIVEN** a variable-focus request on a symbol in a language outside the CFG overlay's
  supported set
- **WHEN** the tool responds
- **THEN** it returns the whole span plus an explicit `sliceUnavailable` reason naming the
  language boundary — never a partial slice and never a silent full body that implies slicing
  was applied

#### Scenario: Stale focused coordinates fail closed

- **GIVEN** the selected source file no longer matches the cached generation's content hash or
  artifact-mtime fallback
- **WHEN** a focused read is requested
- **THEN** the tool returns a machine-readable stale refusal with no slice and no body derived
  from the stale indexed span

#### Scenario: Legacy full-body calls do not change

- **GIVEN** a caller omits both `focus` and `focusKind`
- **WHEN** `get_function_body` runs through the indexed or line-scan path
- **THEN** its response is byte-for-byte identical to the response before focused reads existed

### Requirement: EnforcementBaselineRatchet

The enforcement policy SHALL support a fourth categorical class, `frozen`, alongside
`blocking | advisory | off`. An ordinary, non-hook `openlore enforce` run SHALL explicitly
bootstrap each successfully assessed frozen code into a deterministic, human-readable,
VCS-committable baseline under `.openlore/`; an initialized marker SHALL be retained even when
the code has zero findings. Finding identity SHALL be the stable `code` plus `subject`, with a
source-owned stable discriminator where one subject can produce multiple findings, and SHALL
exclude message text and file:line. Hook and review gates SHALL NOT initialize a missing code.

After initialization, the trusted committed baseline SHALL be shrink-only for that code: a
candidate baseline that adds an identity or removes its initialized marker SHALL fail integrity
checking, while an identity whose finding no longer fires SHALL be removed after a complete
assessment. A hook SHALL require that ratchet edit to be staged; review SHALL evaluate the
committed baseline read-only and direct the operator to run `openlore enforce` for the shrink.
An unavailable, partial, malformed, oversized, or unsafe baseline/assessment SHALL preserve the
existing bytes and fail closed for the affected frozen policy instead of initializing or deleting
entries. Baseline-matched findings SHALL report as frozen; absent findings SHALL block as new;
every gate result SHALL disclose disjoint frozen and new counts. A baseline SHALL be written only
for an explicit frozen mapping. Downgrading to advisory SHALL leave it byte-for-byte unchanged,
and re-upgrading SHALL resume against the same ratchet. No tuning constant is introduced.

#### Scenario: Brownfield adoption blocks only new debt

- **GIVEN** a repository with 312 pre-existing findings for a code the operator maps to `frozen`
- **WHEN** the operator bootstraps with non-hook `openlore enforce`, commits the baseline and
  policy, and a later change introduces 2 findings not in that trusted baseline
- **THEN** bootstrap freezes the 312 without blocking, and the later run blocks on exactly
  the 2, disclosing "312 frozen, 2 new → blocked on the 2"

#### Scenario: The ratchet prevents regressions from returning

- **GIVEN** a frozen finding that a developer fixes
- **WHEN** a complete enforce run removes its baseline line, the update is committed, and a later
  change re-introduces the same finding
- **THEN** the re-introduced finding is absent from the trusted baseline and blocks; adding its
  identity back in the candidate change also fails integrity checking

#### Scenario: An empty snapshot cannot silently re-freeze later debt

- **GIVEN** a frozen code that was bootstrapped with zero findings
- **WHEN** its first finding appears in a later change
- **THEN** the retained initialized marker makes that finding new and the gate blocks

#### Scenario: Incomplete assessment never shrinks trusted debt

- **GIVEN** an initialized frozen code with committed finding identities
- **WHEN** its finding source fails, omits candidates, or reaches a reporting cap
- **THEN** the gate discloses incomplete assessment, preserves the baseline byte-for-byte, and
  does not treat the absent results as fixes

#### Scenario: Moving a frozen violation does not un-freeze it

- **GIVEN** a baselined finding whose subject moves to a different line within its file
- **WHEN** the gate re-runs
- **THEN** the finding still matches its baseline entry (identity is code + subject, not
  file:line) and remains frozen

#### Scenario: Downgrading the policy preserves the frozen record

- **GIVEN** a code mapped `frozen` with a committed baseline
- **WHEN** the operator downgrades the code to `advisory`
- **THEN** the gate stops blocking on that code, the baseline file is left untouched, and a later
  re-upgrade to `frozen` resumes against the ratcheted baseline

### Requirement: EnforcementEligibilityIsDeclaredAndPublishedAsSeparateMeasurements

The system SHALL maintain an eligibility classification for every authoritative decision, with
exactly three states: eligible, meaning the decision's intent reduces to a concrete checkable
repository property; ineligible, which SHALL carry a stated reason; and unclassified, meaning no
judgment has been made. Unclassified SHALL be a valid state, not an error and not a defect.

The system SHALL NOT infer, guess, or bulk-assign an eligibility classification. Classification
SHALL be a declared, reviewable act. An eligible decision carrying no constraints SHALL remain
visible as a coverage gap and SHALL NOT be counted as covered.

Reporting SHALL publish, as four separate measurements that the system SHALL NOT combine into a
single figure: adoption, being the constrained share of all authoritative decisions; coverage,
being the constrained share of eligible decisions; the count of unclassified decisions; and the
count of active rules. Each report SHALL state which measurement is which, so that a reader can
distinguish what is machine-enforced from what is written down.

A decision whose intent is only partly reducible to checkable properties MAY be classified eligible
provided the report states both the enforced boundary and the remainder that still requires human
judgment. The system SHALL NOT present a partially enforced decision as fully enforced.

The classification and the four measurements SHALL be deterministic functions of the corpus and
SHALL be byte-stable across repeated runs over unchanged corpus bytes.

#### Scenario: The four measurements are reported separately

- **GIVEN** a decision corpus containing authoritative decisions in all three eligibility states
- **WHEN** the enforcement report is produced
- **THEN** adoption, coverage, the unclassified count, and the active-rule count each appear as
  their own labelled measurement
- **AND** no single combined enforcement percentage is presented

#### Scenario: Eligibility is never inferred

- **GIVEN** a decision with no declared eligibility classification
- **WHEN** the report is produced
- **THEN** it is counted as unclassified
- **AND** the system does not assign it eligible or ineligible on its behalf

#### Scenario: An eligible decision with no rules stays a visible gap

- **GIVEN** a decision classified eligible that declares no constraints
- **WHEN** coverage is computed
- **THEN** the decision counts toward the eligible denominator and not toward the constrained
  numerator
- **AND** it is listed as a coverage gap

#### Scenario: An ineligible classification states its reason

- **GIVEN** a decision classified ineligible
- **WHEN** the report is produced
- **THEN** the stated reason accompanies the classification
- **AND** a classification without a reason fails validation

#### Scenario: A partially enforceable decision discloses its remainder

- **GIVEN** an eligible decision whose constraints cover only part of its intent
- **WHEN** the report is produced
- **THEN** both the enforced boundary and the human-review remainder are stated
- **AND** the decision is not presented as fully enforced

### Requirement: SearchResultsCarryMatchEvidence

Every result served by `search_code`, `search_specs`, or a search-derived section of `orient` SHALL
carry a non-empty match-evidence structure stating
which field matched, which query terms matched, and the retrieval tier. The matched field SHALL be
drawn from a closed enumeration covering the symbol name, the path, the signature, the
documentation text, the body, and a dense-vector neighbourhood. Matched terms SHALL be reported in
query order in the tokenized form the matcher compared. For a dense-vector match the matched-terms
list SHALL be empty and the field SHALL state that the match was a vector neighbourhood; the system
SHALL NOT fabricate a lexical explanation for a non-lexical match.

The repository-wide aggregate corpus SHALL remain unchanged. Once the scorer selects its bounded
candidate window, it SHALL allocate each candidate's exact aggregate query-term contribution over
the fields of that scored row with the same tokenizer. It SHALL NOT build a second corpus, query the
index again, or compute an alternative ranking, and field attribution SHALL NOT change scores or
candidate order.

The lexical scorer SHALL preserve its aggregate term-frequency score and ordering while attributing
per-field contributions for bounded candidates. The field with the greatest contribution SHALL win; ties SHALL use the
fixed order `symbol`, `path`, `signature`, `doc`, `body`. Code symbols, signatures, documentation,
and bodies SHALL map directly; the language marker and file path that share the scored prefix SHALL
map to `path`. For specs, requirement-title tokens SHALL map to `symbol`, the scored spec/domain
marker to `path`, and requirement prose to `doc`. Canonical IDs and section labels SHALL remain
target/filter metadata and SHALL NOT be presented as lexical matches because the current ranker
does not score them. Literal-line search results SHALL map to `body`. Repeated
matched query tokens SHALL remain repeated and in query order.

The tier SHALL be one of `1` (lexical/BM25), `2` (hybrid fusion), or `3` (dense-only). A hybrid
candidate with a non-zero lexical contribution SHALL name its winning lexical field; a candidate
admitted only by dense retrieval SHALL name the vector field.

The evidence SHALL describe the structural match only. It SHALL NOT carry a relevance judgment,
quality score, confidence value, or any number other than the tier.

The field SHALL be additive: present result keys keep their names, types, and order, and no tool is
added or removed by this requirement. The same evidence object SHALL be emitted by the
command-line and the tool surfaces from one implementation, and a parity check SHALL fail when the
two diverge. Evidence SHALL be deterministic: the same index state and query yield byte-identical
evidence.

#### Scenario: A name-exact hit is distinguishable from a body hit

- **GIVEN** a query whose term matches one result's symbol name and another result's body text
- **WHEN** the results are served
- **THEN** the first result's evidence names the symbol field and the second names the body field
- **AND** each lists the terms that matched

#### Scenario: A vector match says so

- **GIVEN** a result surfaced by dense-vector similarity with no lexical term match
- **WHEN** the result is served
- **THEN** its evidence names the vector field and carries an empty matched-terms list
- **AND** no lexical term is attributed to it

#### Scenario: Evidence agrees with the ranking that produced it

- **GIVEN** any served result set
- **WHEN** the evidence is compared against the matcher's winning field and matched terms
- **THEN** they are equal for every result

#### Scenario: Evidence is not a verdict

- **GIVEN** any served result
- **WHEN** its evidence is inspected
- **THEN** it contains no relevance, quality, or confidence value

#### Scenario: The two faces do not diverge

- **GIVEN** the same query issued through the command-line surface and through the tool surface
- **WHEN** the evidence from each is compared
- **THEN** the two are identical

### Requirement: RetrievalMissesAreExplainedForANamedTarget

The system SHALL provide a diagnostic that, given a query, a search surface, and a discriminated
named target, reports
deterministically why that target did not surface. The reported cause SHALL be drawn from a closed
set distinguishing at minimum: the target is not in the index; the capability is unsupported for
the target's language; no query term matched any field of the target; a filter excluded it, naming
the filter and its value; it ranked below the returned results, naming its rank and the cutoff; and
the result budget truncated it.

The diagnostic SHALL require a named target. Invoking it without one SHALL be a usage error, and
the system SHALL NOT enumerate everything that failed to match.

The target kind SHALL be `symbol`, `file`, or `requirement`. A symbol MAY be scoped by file; an
unscoped ambiguous symbol SHALL return a usage error with bounded candidates. A requirement SHALL
use its canonical id. A target that surfaced SHALL return its 1-based rank and match evidence and
SHALL NOT be assigned a miss cause.

Miss causes SHALL be evaluated in this order: capability unsupported for the resolved target
language; target not indexed; filter exclusion; no matching lexical query term for a target absent
from the candidate trace; rank below the clamped requested limit within that trace; then omission
by the ordinary bounded candidate window. `cutoff` SHALL mean the clamped requested result limit.
`budget-truncated` SHALL name `candidate-window`; presentation token budgets and transport-level
response capping SHALL NOT be diagnosed because they are not observable by this retrieval trace.

The diagnosis SHALL use the same requested-limit matcher candidate window, tokenizer, and filter
path that produced the result set, never a widened or parallel ranking. The diagnostic SHALL explain existing
behavior and SHALL NOT change it: no result matches, ranks, filters, or truncates differently
because the diagnostic exists, and existing search results remain byte-identical apart from the
additive match-evidence field.

The diagnosis SHALL be deterministic and offline: the same index state, query, and target yield the
same cause, with no model, embedding-service call, or network request in the diagnostic path
beyond whatever the ordinary query itself performs.

#### Scenario: A term that matched nothing is named as the cause

- **GIVEN** a target present in the index and a query none of whose terms match any of its fields
- **WHEN** the diagnostic runs for that target
- **THEN** it reports that no query term matched any field of the target

#### Scenario: A filter that excluded the target is named

- **GIVEN** a query carrying a language filter and a target written in a different language
- **WHEN** the diagnostic runs for that target
- **THEN** it reports that a filter excluded the target and names the filter and its value

#### Scenario: An outranked target reports its rank

- **GIVEN** a target that matched the query but placed below the returned results
- **WHEN** the diagnostic runs for that target
- **THEN** it reports that the target was outranked and names its rank and the cutoff

#### Scenario: An unindexed target is not reported as a non-match

- **GIVEN** a target that is absent from the index
- **WHEN** the diagnostic runs for that target
- **THEN** it reports that the target is not indexed
- **AND** it does not report that no term matched

#### Scenario: The diagnostic refuses an open enumeration

- **GIVEN** the diagnostic invoked with a query and no named target
- **WHEN** the request is handled
- **THEN** it returns a usage error
- **AND** no corpus-wide list of non-matches is produced

#### Scenario: Diagnostics do not perturb results

- **GIVEN** a fixed corpus and query set
- **WHEN** search results are captured before and after the diagnostic capability exists
- **THEN** the result sets and their ordering are identical

### Requirement: EditVerdictIsDerivedAtPatchTime

When the watcher patches the graph for an edited file, it SHALL derive a per-edit verdict from
the pre/post facts already in hand: removed-or-renamed symbols with surviving resolved call
sites (`edit-broken-reference`, each caller named `file:line`), provably incompatible call
sites against changed signatures (`edit-arity-mismatch`), imports of names the file no longer
exports (`edit-import-breakage`), and the reaching tests for the edited symbols. The verdict
SHALL be derived after the entire coalesced edit batch has been patched. Reaching tests SHALL
be selected by exact node identity from the retained full-analysis graph, SHALL disclose that
basis, and SHALL become stale when a source or test basis hash changes. Production graph APIs
SHALL NOT be widened with test nodes solely for this feature. The verdict SHALL persist beside
the artifacts keyed to its analysis generation, edit content hash, and fact-basis hashes, and `openlore check-edit`
SHALL serve it as a read — no analysis in the read path. In hook mode, infrastructure failure or
an absent daemon SHALL never block (advisory default; blocking only via `enforcement.policy` on
the registered codes), and with no daemon the command MAY compute a one-file scoped diff
directly, disclosing the slower path.

#### Scenario: A deleted export with live callers becomes a finding within one debounce

- **GIVEN** a daemon-watched repo where an edit deletes an exported function that two other
  files call
- **WHEN** the watcher's patch for that save completes
- **THEN** the persisted verdict contains `edit-broken-reference` naming both call sites
  `file:line`, and `check-edit` returns it without re-parsing anything

#### Scenario: The hook never blocks on infrastructure

- **GIVEN** hook mode with no daemon running and a store that fails to open
- **WHEN** `check-edit --hook` runs
- **THEN** it exits non-blocking with the failure disclosed on stderr — a broken substrate
  never vetoes an edit

### Requirement: EditVerdictNeverGuessesIncompatibility

An `edit-arity-mismatch` finding SHALL be emitted only when incompatibility is provable from
stored facts: argument count below the required (non-defaulted) parameter count, or above the
total parameter count with no variadic/spread/lower-bound marker involved. Default parameters,
variadics, spread arguments, overloads, and out-of-scope languages SHALL produce no finding.
Language scope SHALL be disclosed in the verdict; silence outside the provable set is the
contract — the verdict is a sound lower bound on breakage, never an over-approximation.

#### Scenario: A provable mismatch fires

- **GIVEN** a Python function changed from `def f(a, b)` to `def f(a, b, c)` (no defaults) and
  a stored call site with exact `argCount: 2`
- **WHEN** the verdict derives
- **THEN** `edit-arity-mismatch` names that call site

#### Scenario: A default parameter silences the check

- **GIVEN** the same change but `def f(a, b, c=1)`
- **WHEN** the verdict derives
- **THEN** no arity finding is emitted — compatibility is possible, so the verdict says nothing

### Requirement: ArchitectureRuleVocabulary

The architecture checker SHALL evaluate, in addition to `layers`/`forbidden`/`allowedOnly`, the
declarative rule kinds `required`, `circular`, `reachable`, `orphan`, and `moreUnstable` over the
cross-language dependency graph, with `$1` capture groups usable between a rule's path patterns.
All rules SHALL remain author-declared and totally parsed (malformed entries become warnings).
Every violation SHALL be emitted as a `GovernanceFinding` with a stable code registered in
`FINDING_CODE_REGISTRY`, advisory by default and blocking only via operator `enforcement.policy`.
Instability SHALL be derived solely from stored fan-in/fan-out (I = fanOut / (fanIn + fanOut)) with
no new constant or threshold. A verdict resting on lower-confidence edges (e.g. `name_only`) SHALL
disclose that confidence, and `orphan`/`reachable` conclusions SHALL cross-reference
`find_dead_code` as their sibling rather than duplicating its report.

The config shapes SHALL be `required: [{ from, to, reason? }]`,
`circular: [{ scope, allowed?: string[], reason? }]`,
`reachable: [{ from, to, reason? }]`, `orphan: [{ scope, reason? }]`, and
`moreUnstable: [{ scope, reason? }]`. `required` SHALL require a direct dependency from every
matched source file. For `reachable`, `from` SHALL name the permitted origin prefix and `to` the
protected target prefix. A path pattern MAY contain one whole-segment `$1` capture; target patterns
MUST NOT reference `$1` unless the source pattern binds it. No general regular expression SHALL be
evaluated.

#### Scenario: A required dependency is missing

- **GIVEN** a rule `{ kind: "required", from: "src/handlers/", to: "src/sanitizer" }` and a handler
  file with no path to the sanitizer
- **WHEN** `check_architecture` runs
- **THEN** an `architecture-required-missing` finding names the handler file

#### Scenario: A cycle is flagged unless excepted

- **GIVEN** a `circular` rule over `src/` with an `allowed` exception list, and a dependency cycle
  A → B → A outside the exceptions
- **WHEN** the checker runs
- **THEN** an `architecture-cycle` finding lists the cycle's members in a deterministic order
- **AND** a cycle whose members match an `allowed` entry is not flagged

#### Scenario: A reachability breach and an orphan are distinct findings

- **GIVEN** a `reachable` rule "nothing outside `src/public/` may transitively reach `src/internal/`"
  and an `orphan` rule over `src/lib/`
- **WHEN** an outside file transitively reaches `src/internal/` and a `src/lib/` module has no
  incoming edges
- **THEN** the breach yields `architecture-unreachable-breach` with the offending path, and the
  orphan yields `architecture-orphan` cross-referencing `find_dead_code` for the deletion question

#### Scenario: A capture group expresses the same-folder invariant once

- **GIVEN** a rule with `from: "domains/$1/"` allowing only `["domains/$1/", "shared/"]`
- **WHEN** `domains/billing/a.ts` imports `domains/orders/b.ts`
- **THEN** a violation is emitted, while an import within `domains/billing/` or from `shared/` is not

#### Scenario: An instability inversion is flagged without a threshold

- **GIVEN** a `moreUnstable` rule over `src/core/` and a module whose instability (from stored
  fan-in/fan-out) is strictly lower than a module it depends on
- **WHEN** the checker runs
- **THEN** an `architecture-instability-inversion` finding reports both instability values
- **AND** no configurable threshold participates in the verdict

#### Scenario: Findings are policy-governed, advisory by default

- **GIVEN** any architecture violation and no operator `enforcement.policy` naming its code
- **WHEN** `openlore enforce` runs
- **THEN** the finding is reported but does not block
- **AND** a policy mapping the code to `blocking` makes the same finding gate

### Requirement: DiscloseSpecIndexStalenessThroughAnAtomicReceipt

This domain SHALL conform to the canonical statement of decision `58cd7afe`, which lives in the
`analyzer` domain — see [analyzer/spec.md](../analyzer/spec.md).

#### Scenario: The canonical statement governs

- **GIVEN** decision `58cd7afe` recorded in the `analyzer` domain
- **WHEN** this domain's behavior touches that decision's surface
- **THEN** it satisfies the canonical requirement as stated in [analyzer/spec.md](../analyzer/spec.md)

> Decision pointer: 58cd7afe — "Disclose spec index staleness through an atomic receipt" is recorded in `openspec/specs/analyzer/spec.md`; it also affects this domain.

### Requirement: ExposeScoreSemanticsOnSearchResults

This domain SHALL conform to the canonical statement of decision `9eb51001`, which lives in the
`analyzer` domain — see [analyzer/spec.md](../analyzer/spec.md).

#### Scenario: The canonical statement governs

- **GIVEN** decision `9eb51001` recorded in the `analyzer` domain
- **WHEN** this domain's behavior touches that decision's surface
- **THEN** it satisfies the canonical requirement as stated in [analyzer/spec.md](../analyzer/spec.md)

> Decision pointer: 9eb51001 — "Expose score semantics on search results" is recorded in `openspec/specs/analyzer/spec.md`; it also affects this domain.

### Requirement: SearchScoresAreSelfDescribing

Every search result served through `search_code` and `search_specs` SHALL carry a `scoreKind`
field naming the score's semantics and polarity (`rrf` and `bm25`: higher is more relevant;
`cosine_distance`: lower is more similar). A numeric relevance score SHALL NOT be served whose
meaning depends on the retrieval mode without that per-result disclosure — disclosure in a source
comment or a top-level `retrievalMode` field alone is not sufficient, because the polarity flip is
per-result-consumable information. Score normalization to a single higher-is-better scale is
permitted but optional; the self-describing field is the requirement.

#### Scenario: Spec search polarity is disclosed

- **GIVEN** a `search_specs` call under semantic mode (cosine distance) and the same call under
  BM25 keyword mode
- **WHEN** results are served
- **THEN** each result's `scoreKind` states which semantics its score carries, so a consumer never
  ranks distance ascending as if it were relevance descending

#### Scenario: No bare mode-dependent score

- **GIVEN** any code path that serves a search score (RRF merge, BM25, or a dense-distance branch)
- **WHEN** the result reaches a tool consumer
- **THEN** the score is accompanied by its `scoreKind`, including on branches that are latent today

### Requirement: PersistStaleregionCompositionInTheEdgeStore

This domain SHALL conform to the canonical statement of decision `fda1fc53`, which lives in the
`analyzer` domain — see [analyzer/spec.md](../analyzer/spec.md).

#### Scenario: The canonical statement governs

- **GIVEN** decision `fda1fc53` recorded in the `analyzer` domain
- **WHEN** this domain's behavior touches that decision's surface
- **THEN** it satisfies the canonical requirement as stated in [analyzer/spec.md](../analyzer/spec.md)

> Decision pointer: fda1fc53 — "Persist stale-region composition in the edge store" is recorded in `openspec/specs/analyzer/spec.md`; it also affects this domain.

## Decisions

### Build the MCP live-data test harness as an integration-only, behavior-neutral verification layer

**Status:** Approved
**Date:** 2026-06-10
**ID:** f4bb8a8f

Spec-09 drives every tool in TOOL_DEFINITIONS against real OSS repos (pinned by URL+SHA, fetched into a gitignored cache) to catch real-world-only tool defects. The design splits responsibilities: the tool-driver registry, invariant helpers (secret/path scan, budget, shape), and the manifest are pure and tested by plain *.test.ts files that run in CI offline; the clone→init→analyze→drive pipeline lives only in *.integration.test.ts and skips with a loud log when offline. Tools are driven via the existing dispatchTool() single entry point. The static coverage gate (every TOOL_DEFINITIONS name has a driver registry entry) is the headline anti-rot guard and runs offline; the dynamic gate (every tool actually exercised) runs in the integration suite and distinguishes offline-skip from missing-driver.

**Consequences:** Adds src/core/services/mcp-handlers/live-data/ (manifest, repo-cache, analyze-repo, tool-driver, invariants, report, integration test, plain unit tests). Adds a gitignored cache dir and a test:live script. No tool handler, TOOL_DEFINITIONS, dispatch, or protocol code is modified — any defect found is recorded as a TODO(spec-09-followup), never fixed in this change. LLM-backed tools are driven in dryRun where available or skipped behind an env flag when no API key, still covered by the static registry guard.

### Compute CFG/def-use overlay inside live-tree extractors, extend return contract to {nodes, rawEdges, cfg}

**Status:** Approved
**Date:** 2026-06-12
**ID:** c8f2b9bf

Parse trees are freed per-extractor before later passes (WASM path calls tree.delete), so a CFG/def-use pass cannot run as a late pass over already-built FunctionNodes — the AST is gone. The overlay must be computed inside each extractor while the tree is live. A shared cfg.ts module builds per-function basic blocks and runs an intra-procedural reaching-definitions fixpoint to produce labeled (exact|may) def-use edges, all from AST shape with no LLM.

**Consequences:** Every in-scope extractor (TS/JS, Python, Go in v1) gains an optional cfg build call; CallGraphResult carries a transient cfgs map threaded to the DB writer. The overlay is DB-only (new tables, SCHEMA_VERSION bump 6→7) and is NOT added to SerializedCallGraph or the hot cache, so resident memory is unchanged. Unsupported languages return cfg undefined (fail-soft).

### Value-level impact/trace falls back to function granularity on an ill-posed query

**Status:** Approved
**Date:** 2026-06-14
**ID:** 313b897e

Dogfooding showed the value-level opt-in could silently report zero blast radius when valueReachableLines() returned an empty set — e.g. a mistyped valueParam that matches no parameter/local, or an "all parameters" request on a function the overlay extracted no params for. Zero downstream reads to an agent as "this change is safe," the exact failure value-level must avoid. The handlers now treat a query as well-posed only when its target resolves in the overlay (a named valueParam is a parameter or a tracked def-use variable; an unnamed request needs at least one parameter) and otherwise fall back to the full function-granularity result with an explicit reason, instead of an empty narrowed slice.

**Consequences:** analyze_impact and trace_execution_path return applied:false with a clear reason (and the full blast radius / unrestricted first hop) when the value-level target can't be resolved, rather than a misleading zero. A genuine zero — a real parameter that flows to no callee — is still reported as a sound applied:true narrowing. Regression-tested in graph.test.ts.

### Anchor persisted memory to call-graph symbols with deterministic freshness

**Status:** Approved
**Date:** 2026-06-16
**ID:** 34b178df

Every persisted memory (architectural decisions and remember-notes) carries StructuralAnchors resolved against the call graph, and recall computes a fresh/drifted/orphaned verdict from booleans only (symbol existence + content-hash equality) — no LLM, no threshold, no weighted score. This is what code-anchored memory can do that probabilistic vector memory cannot: self-invalidate when the code it describes changes or dies, so recall never serves stale context silently.

**Consequences:** New StructuralAnchor/MemoryFreshness/AnchoredMemory types and a pure anchor engine (decisions/anchor.ts) plus a disk adapter. record_decision now captures anchors. Two new opt-in MCP tools (remember/recall) in a 'memory' preset, kept out of the default/minimal surface. recall enforces a no-silent-stale guarantee (orphaned memories are never authoritative). Notes stored in .openlore/memory, isolated from the decisions gate. Wiring memory-staleness into check_spec_drift and orient is deferred.

### Code-anchored memory store is separate from the decision store

**Status:** Approved
**Date:** 2026-06-16
**ID:** 517ab4c6

Memories (durable agent notes) serve a different lifecycle than architectural decisions — they have no commit gate, no consolidation, and no spec-sync. Keeping them in .openlore/memory/notes.json avoids coupling two independent persistence concerns.

**Consequences:** Two distinct stores must be loaded and freshness-checked independently at recall time; recall merges results from both stores into one response so callers see a unified view.

### Orphaned memories are never served as authoritative context

**Status:** Approved
**Date:** 2026-06-16
**ID:** dbe6a95e

A memory whose every structural anchor points to deleted or unreachable code cannot be trusted — serving it as fact risks misleading agents into acting on stale assumptions.

**Consequences:** Recall responses partition results into `authoritative` (fresh + drifted) and `needsReanchoring` (orphaned); consumers must not treat needsReanchoring entries as ground truth.

### Decisions carry structural anchors for self-invalidation

**Status:** Approved
**Date:** 2026-06-16
**ID:** 10e6a55e

Anchoring decisions to call-graph nodes (not just file paths) lets the system detect when the described code has been refactored or deleted, enabling deterministic staleness detection without LLM inference.

**Consequences:** record_decision now depends on AnchorContext / call-graph data at recording time; if no analysis exists the decision falls back to file-level freshness, which is less precise but not a failure.

### Value-level impact/trace falls back to function granularity on ill-posed queries instead of reporting zero

**Status:** Approved
**Date:** 2026-06-16
**ID:** a37d851f

Dogfooding revealed that valueReachableLines() could return an empty set on ill-posed queries (mistyped valueParam, or 'all parameters' on a function with no overlay params), which an agent interprets as 'this change is safe' — the exact failure value-level must avoid. The handlers now validate that the target resolves in the overlay (a named valueParam is a known parameter or tracked def-use variable; an unnamed request needs at least one parameter) and fall back to full function-granularity with an explicit reason when it does not, rather than returning a misleading zero-impact narrowing.

**Consequences:** analyze_impact and trace_execution_path return applied:false with a clear reason (plus the full blast radius / unrestricted first hop) when the value-level target can't be resolved. A genuine zero — a real parameter that flows to no callee — is still reported as applied:true. Regression-tested in graph.test.ts.

### Downgrade stable-id move confidence from 'exact' to 'stable-id' with verify semantics

**Status:** Approved
**Date:** 2026-06-16
**ID:** a3ede102

A content-addressed stable id (name + parameter shape) is necessary but not sufficient to prove a symbol moved: a deleted symbol independently replaced by a same-name/same-shape homonym is indistinguishable from a genuine move. Labeling it 'exact' gave agents false certainty; 'stable-id' plus a verify directive is more honest.

**Consequences:** Agents consuming structural-diff output must treat confidence:'stable-id' as strong-but-not-proven and verify cross-file moves instead of trusting them blindly. Any downstream automation that branches on confidence === 'exact' must update to handle 'stable-id'.

### Pass language to signatureShape for heuristic rename pairing

**Status:** Approved
**Date:** 2026-06-16
**ID:** 767d5274

Signature shape comparison without language context could incorrectly pair symbols across languages that happen to share textual shape; threading the language parameter makes the heuristic language-aware.

**Consequences:** signatureShape callers must supply the language argument; cross-language false-positive rename pairings are reduced.

### Locate the stableId parameter group by the symbol's name, not the first paren

**Status:** Approved
**Date:** 2026-06-16
**ID:** 4a5c5353

signatureShape assumed the parameter group is the first `(` in the captured signature (after a Go-receiver skip). For languages whose captured signature includes the body of a paren-less definition — Ruby (`def total; compute(5); end`), Scala (`def total = compute(5)`), and paren-less arrows (`const f = a => g(a)`) — the first `(` belongs to a body call, so the body leaked into the stableId. That broke the spec's body-invariance guarantee: editing the body flipped the id, so a moved-and-edited symbol read `orphaned`/remove+add instead of `drifted`/move. Fix: parameterGroupStart is now name-anchored — the parameter group is the first `(` whose immediately preceding token is the symbol's own name (or operator name), with an assigned lambda (`= (a) =>`) recognized too. This also subsumes the Go receiver skip (the receiver `(` is preceded by `func`, not the method name) and skips arg-bearing decorators. When no name is supplied (bare unit-test calls) the legacy first-`(` heuristic is preserved, so the change is backward-compatible.

**Consequences:** stableId is now genuinely body-invariant for paren-less Ruby/Scala/arrow definitions (verified end-to-end: a paren-less Ruby method moved across files with a body edit is reported as a stable-id move, not remove+add). arityOf (SCIP monikers) shares the same name-anchored detection. All 13 supported-language stableIds are byte-identical to before (zero regressions); full suite 3673 green; audit clean. signatureShape/parameterGroupStart gain an optional trailing `name` argument.

### Anchor stableId parameter-group detection to the symbol's own name, not the first parenthesis

**Status:** Approved
**Date:** 2026-06-16
**ID:** 52b10e56

signatureShape assumed the parameter group starts at the first `(` in the captured signature (after a Go-receiver skip). For languages whose captured signature includes the body of a paren-less definition — Ruby (`def total; compute(5); end`), Scala (`def total = compute(5)`), and paren-less arrows (`const f = a => g(a)`) — the first `(` belongs to a body call, so body content leaked into the stableId. That broke the spec's body-invariance guarantee: editing the body flipped the id, causing a moved-and-edited symbol to read as remove+add instead of a stable move. Fix: the parameter group is now the first `(` whose immediately preceding token is the symbol's own name (or operator name), with assigned lambdas (`= (a) =>`) recognized too. This subsumes the Go receiver skip (receiver `(` is preceded by `func`, not the method name) and skips arg-bearing decorators. When no name is supplied (bare unit-test calls) the legacy first-`(` heuristic is preserved for backward compatibility.

**Consequences:** stableId is genuinely body-invariant for paren-less Ruby/Scala/arrow definitions; a paren-less method moved across files with a body edit is reported as a stable-id move, not remove+add. arityOf (SCIP monikers) shares the same name-anchored detection. signatureShape/parameterGroupStart gain an optional trailing `name` argument. All 13 supported-language stableIds are byte-identical to before (zero regressions).

### Personalized PageRank as query-conditioned retrieval ranking (not global salience)

**Status:** Approved
**Date:** 2026-06-16
**ID:** 0bdd4319

Shortest-path distance ranks a candidate by its single cheapest path to the task seeds; it cannot capture multi-path / connectivity-weighted relevance. Personalized PageRank (random-walk-with-restart seeded on the task's matched symbols) ranks a candidate by how many ways and how densely it is connected to the task, which is a better objective for pulling the most task-relevant functions into a fixed token budget. This is exposed strictly as an opt-in retrieval ranking mode on existing handlers (orient, get_minimal_context), seeded by the task-symbol set orient already computes — it is query-conditioned, never a global task-independent importance number. It refines the scope of the add-structural-landmark-salience decision (c6d1ad07 lineage) to global salience only; it does not overturn it. It introduces no new tuning constant — damping (0.85) and convergence tolerance (1e-6) are extracted to shared named constants with the existing PageRank in dependency-graph.ts. It must demonstrate lift over the distance ranker on >=2 real repos or be closed.

**Consequences:** Adds an opt-in rankBy: "pagerank" mode to orient and get_minimal_context; default behavior of every handler stays byte-identical and the distance ranker is retained. A new deterministic personalized-PageRank primitive is added over the in-memory call graph (sorted-id iteration, id tie-break, distance-bounded neighborhood). No new MCP tool and no change to default/minimal/preset tool surfaces. If the acceptance comparison shows no lift, the change is closed and the landmark decision is left intact.

### Epistemic lease emits neutral freshness facts, not coercive imperatives

**Status:** Approved
**Date:** 2026-06-16
**ID:** 8e95746d

The epistemic-lease feature injected escalating imperative language into every MCP tool response (STOP, "Repository model: EXPIRED", "do NOT…"). This is structurally a prompt-injection pattern — it trains agents to obey authoritative imperatives in tool output, the exact behavior agents must resist — and contradicts the north-star decision (c6d1ad07: deterministic structural facts, not guessing) and the landmark-salience principle (hand the agent facts, let it rank). Wall-clock age alone escalated to CRITICAL (false positive), and the agent's own commits flipped the lease to stale via git-hash divergence even though committing is the most-informed action in a session. Fix: emit a single neutral, factual freshness note (minutes since orient, cognitive load since orient, whether the analysis index is behind HEAD) phrased as information the agent can act on, not a command. Drive severity from accumulated cognitive load, not wall clock.

**Consequences:** staleBlock/degradedSignal reworded to neutral facts (no STOP/EXPIRED/do-NOT, no system-banner box art); git-hash divergence no longer forces stale — it sets a factual index-behind-HEAD flag and at most contributes to degraded; computeStaleDepth driven by cognitive load, not wall-clock age; decay tracking, cross-module density/oscillation model, and telemetry retained; epistemic-lease gains a spec requirement (mcp-handlers) and ADR where it previously had neither.

### Use a deterministic field-weighted ranker for recall (no learned model)

**Status:** Approved
**Date:** 2026-06-18
**ID:** 08005eb9

recall previously ranked memories by binary substring token-overlap, which silently dropped relevant memories on a phrasing mismatch (e.g. a camelCase identifier vs a plain word). Replaced it with a deterministic field-weighted, graded ranker: identifier-aware normalization (camelCase/PascalCase/snake_case/kebab-case split before lower-casing, fixed stopword set), fixed field weights (anchorSymbol 4 > tag 3 > anchorFile 2 > content 1), occurrence-capped grading, and an exact-anchor boost (8) when the query names every subtoken of an anchored symbol. This keeps the memory path LLM-free and embedding-free per the north star (decision c6d1ad07) while fixing the worst retrieval failure mode. A substring fallback (weight 0.1, applied only when the token score is zero) guarantees the candidate set is a superset of the old behavior.

**Consequences:** Weights and the stopword set are fixed, documented, exported constants — changing them is a code+test change, not a runtime knob. recall items gain an optional match {fields, anchorBoost} field for transparent ranking reasons. Embedding-backed recall is deliberately deferred to a future proposal with its own decision. The authoritative/orphaned freshness split is unchanged and still runs after ranking.

### Name the pre-flight blast-radius guard `blast_radius` (MCP) / `blast-radius` (CLI), distinct from the existing `preflight` staleness gate

**Status:** Approved
**Date:** 2026-06-18
**ID:** 987286eb

The add-preflight-blast-radius-guard proposal is titled "pre-flight blast-radius guard," but `openlore preflight` already exists as an unrelated CI graph-staleness gate (src/cli/preflight/). Reusing the word "preflight" across both surfaces would conflate two different concerns. The new capability is named `blast_radius` everywhere to be collision-free and self-describing ("compute my diff's structural blast radius"). It is implemented as pure orchestration of existing deterministic analyses (analyze_impact, select_tests, check_spec_drift which already folds in anchored-memory + ADR drift, and getChangedFiles) composed into a single conclusion-shaped briefing — no new structural computation, no LLM. The MCP tool is classified `conclusion` and kept out of the `minimal` preset. The git hook is advisory-by-default (exit 0); opt-in blocking for named high-risk patterns reads `.openlore/config.json` `blastRadius.block`. The multi-repo-federation cross-repo-consumers input is scoped out (federation not yet shipped) and documented as a no-op with a note.

**Consequences:** A new MCP tool `blast_radius` and CLI `openlore blast-radius` (with --install-hook, --hook, --json) ship; OpenLoreConfig gains an optional `blastRadius?: { block?: string[] }` field; a new advisory pre-commit hook block (marker `# openlore-blast-radius-hook`) installs alongside the decisions hook. Federation cross-repo consumers remain a documented gap until add-multi-repo-federation lands.
### confidenceBoundary response shape: categorical edge-basis + known-unknowable crossings + staleness, never a blended score

**Status:** Approved
**Date:** 2026-06-18
**ID:** 08e71184

Every conclusion tool (analyze_impact, find_path, find_dead_code, get_subgraph, select_tests, trace_execution_path, recall) carries a deterministic `confidenceBoundary` computed from data already present: edge `confidence`/`synthesizedBy` provenance for the basis, synthesized-edge reliance for known-unknowable crossings, and the project fingerprint + git diff for staleness. The shape is categorical labels and counts (directEdges, synthesizedEdges, synthesizedByRule, knownUnknowable[], staleness, complete) — never a blended confidence number and never an LLM call, preserving the north-star (c6d1ad07). It is additive metadata: a caller that ignores it sees today's answer unchanged.

**Consequences:** A new shared module src/core/services/mcp-handlers/confidence-boundary.ts owns the type and computation; seven conclusion handlers each spread a `confidenceBoundary` field into their response. analyze.ts's fingerprint.json gains an optional `commit` field (captured via git rev-parse at analyze time) so the staleness marker can name the build commit; staleness degrades gracefully (no commit / non-git repo → fingerprint-mismatch boolean without a commit name). `complete` is false whenever the computation leaned on a synthesized edge, crossed a known-unknowable boundary, or ran against a stale index — the answer-level NoFalseCompleteness contract.

### Confidence-boundary staleness uses git-diff against the build commit, not a fingerprint-hash recompute

**Status:** Approved
**Date:** 2026-06-18
**ID:** f0b7f99f

Comparing the analyze-time project fingerprint (whole-tree mtime+size hash) against a query-time recompute is unreliable: fixture dirs and mtime drift cause false-positive staleness on every answer, training agents to ignore the marker. Replaced with a deterministic git signal: staleness fires iff `git diff --name-only <buildCommit>` reports graph-relevant source files changed since the index was built. Non-git repos and indexes with no captured commit get NO staleness marker (silent rather than false-positive) — a deliberate honesty tradeoff. This supersedes the "fingerprint-mismatch boolean" degradation described in decision 08e71184 above.

**Consequences:** computeStaleness no longer calls computeProjectFingerprint; it reads the build commit from fingerprint.json and shells `git diff` (memoized 5s per dir). A pure buildStalenessMarker(commit, changedCount) holds the emit/silent logic and is unit-tested. The pre-existing fingerprint-includes-.openlore-live-cache bug that affects isCacheFresh is left untouched and flagged separately.

### Exclude all .openlore-prefixed dirs from the project fingerprint so OpenLore's own caches don't invalidate the analysis cache

**Status:** Approved
**Date:** 2026-06-18
**ID:** cd5ff82c

computeProjectFingerprint walked .openlore-live-cache (the gitignored clone cache for live-data fixtures). Those foreign source files churn whenever the live-data MCP tools or integration tests run, so the content hash flapped even when the user's own source was unchanged — forcing needless full re-analysis and false staleness markers. Generalizing the directory skip from exact `.openlore` to any `.openlore`-prefixed name covers `.openlore`, `.openlore-live-cache`, and future OpenLore-managed dirs in one rule.

**Consequences:** walkForFingerprint now skips directories whose name starts with `.openlore` in addition to the static FINGERPRINT_SKIP_DIRS set. The custom OPENLORE_LIVE_CACHE_DIR override (an arbitrary path) is not covered by the prefix rule — acceptable since the default is the in-repo `.openlore-live-cache`. A regression test asserts live-cache churn leaves the fingerprint unchanged while a real user-source edit still flips the hash.

### Exclude superseded decisions from authoritative recall via one shared supersession predicate

**Status:** Approved
**Date:** 2026-06-19
**ID:** 6c32e6c6

A decision superseded by another (via record_decision with supersedes) remained draft/approved/verified until LLM consolidation flipped it to rejected — which never runs without an API key. This caused orient.pendingDecisions and recall authoritative to serve the superseded decision as current context while simultaneously surfacing it as a do-not-repeat reversal. Fix: a single shared predicate supersededDecisionIds() (where a superseder counts unless it is itself rejected/phantom, preserving the original if the supersession is declined) is used by both collectReversals (warn side) and the authoritative filter in orient.ts and memory.ts (exclude side), ensuring the two surfaces can never disagree, including in the pre-consolidation window.

**Consequences:** A superseded-but-still-active decision is now withheld from pendingDecisions/recall authoritative and surfaced only under reversals. The superseding decision stays authoritative. No LLM consolidation required for supersession to take effect.

### Spec-store binding resolves declared targets by name against the federation registry

**Status:** Approved
**Date:** 2026-06-21
**ID:** c6e36101

A spec-store binding adds an optional OpenLoreConfig.specStore block { name, path, targets[], references? } where targets/references are NAMES that must match entries already in the federation registry (.openlore/federation.json). Resolution and index-state reuse the federation registry verbatim (loadRegistry/listRepos/evaluateRepoState), so the binding adds no new index machinery — it is a thin declarative layer over the shipped index-of-indexes. The health check is read-only and returns conclusion-shaped findings with stable codes (store-path-missing, target-unresolved, target-missing, index-missing, index-stale, reference-missing); it never throws and never blocks. The MCP tool spec_store_status follows the federation_status precedent: present in the full TOOL_DEFINITIONS surface and additionally in the opt-in federation preset, kept out of minimal/navigation/memory.

**Consequences:** Using a spec-store binding requires the target repos to also be registered via `openlore federation add`; a declared name with no registry entry surfaces as a target-unresolved finding with a pasteable remediation rather than an error. Tool count rises 60→61, requiring updates to the count-guarded docs and the --preset help string. Future working-set and impact-certificate tools will extend this binding.

### Scope cold-read repair to active repository hosts

**Status:** Approved
**Date:** 2026-08-09
**ID:** 84eb98ed

One-shot CLI and plain MCP reads must disclose stale cited files without spawning work, while --watch-auto and serve may schedule repair. A canonical-root keyed host registry makes repair authority explicit, prevents one host from repairing another repository, and lets the freshness helper remain dependency-light.

**Consequences:** Watcher and serve lifecycles register and dispose exact-root repair callbacks. Cold-read checks pass only cited stale files to the registered host and label repair scheduled only when that host accepts the request. Plain MCP and one-shot CLI remain disclosure-only.
