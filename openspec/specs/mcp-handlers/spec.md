# MCP Handlers Specification

> Behavioural requirements for specific MCP tool handlers (`src/core/services/mcp-handlers/*`)
> beyond the cross-cutting tool-quality rules in `mcp-quality`. Tool output classification and the
> conclusion-over-graph contract live in `mcp-quality`; this domain captures handler-specific
> navigation semantics.

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
### Requirement: ComputeCfgdefuseOverlayInsideLivetreeExtractorsExtendReturnContractToNodesRawedgesCfg

The system SHALL compute intraprocedural control-flow graphs and reaching-definition def-use edges inside language extractors while the parse tree is live, storing the overlay in the database only.

> Decision recorded: c8f2b9bf
> Date: 2026-06-12
### Requirement: AnchorPersistedMemoryToCallgraphSymbolsWithDeterministicFreshness

The system SHALL anchor persisted memories to call-graph symbols and compute deterministic fresh/drifted/orphaned verdicts on recall without LLM inference.

> Decision recorded: 34b178df
> Date: 2026-06-16
### Requirement: CodeanchoredMemoryStoreIsSeparateFromTheDecisionStore

The system SHALL persist agent memories in a dedicated store (.openlore/memory/notes.json) separate from the decision store, and SHALL surface both memory kinds through the recall tool with per-anchor freshness verdicts.

> Decision recorded: 517ab4c6
> Date: 2026-06-16
### Requirement: OrphanedMemoriesAreNeverServedAsAuthoritativeContext

The system SHALL The recall tool SHALL partition returned memories into authoritative and needsReanchoring sets, and SHALL never include orphaned memories in the authoritative set.

> Decision recorded: dbe6a95e
> Date: 2026-06-16

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
### Requirement: ValuelevelImpacttraceFallsBackToFunctionGranularityOnIllposedQueriesInsteadOfReportingZero

The system SHALL fall back to function-granularity impact when a value-level query target cannot be resolved in the overlay, reporting applied:false with a reason rather than an empty narrowed result.

> Decision recorded: a37d851f
> Date: 2026-06-16
### Requirement: DowngradeStableidMoveConfidenceFromExactToStableidWithVerifySemantics

The system SHALL report cross-file stable-id matches with confidence 'stable-id' and instruct the consumer to verify, rather than asserting the match is exact.

> Decision recorded: a3ede102
> Date: 2026-06-16
### Requirement: AnchorStableidParametergroupDetectionToTheSymbolsOwnNameNotTheFirstParenthesis

The system SHALL anchor stableId parameter-group detection to the symbol's own name so that body edits never alter the identifier.

> Decision recorded: 52b10e56
> Date: 2026-06-16
### Requirement: PersonalizedPagerankAsQueryconditionedRetrievalRankingNotGlobalSalience

The system SHALL support an opt-in personalized-PageRank ranking mode for query-conditioned retrieval in orient and get_minimal_context, seeded by task-matched symbols rather than global salience.

> Decision recorded: 0bdd4319
> Date: 2026-06-16

### Requirement: EpistemicLeaseEmitsNeutralFreshnessFactsNotCoerciveImperatives

The system SHALL surface epistemic-lease freshness as neutral factual signals (elapsed time, cognitive load, index-behind-HEAD) rather than imperative commands directed at the consuming agent.

> Decision recorded: 8e95746d
> Date: 2026-06-16
### Requirement: UseADeterministicFieldweightedRankerForRecallNoLearnedModel

The system SHALL rank recalled memories using a deterministic field-weighted scoring algorithm with identifier-aware normalization, without requiring LLM inference or embedding lookups.

> Decision recorded: 08005eb9
> Date: 2026-06-18

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
### Requirement: ExcludeSupersededDecisionsFromAuthoritativeRecallViaOneSharedSupersessionPredicate

The system SHALL exclude superseded decisions from authoritative recall and orient context using a single shared supersession predicate, surfacing them only as reversal warnings.

> Decision recorded: 6c32e6c6
> Date: 2026-06-19
### Requirement: SpecstoreBindingResolvesDeclaredTargetsByNameAgainstTheFederationRegistry

The system SHALL provide a declarative spec-store binding that resolves named targets against the federation registry and surfaces health findings as conclusion-shaped diagnostics without throwing or blocking.

> Decision recorded: c6e36101
> Date: 2026-06-21

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

### Exclude superseded decisions from authoritative recall via one shared supersession predicate

**Status:** Approved
**Date:** 2026-06-19
**ID:** 6c32e6c6

A decision superseded by another (via record_decision with supersedes) remained draft/approved/verified until LLM consolidation flipped it to rejected — which never runs without an API key. This caused orient.pendingDecisions and recall authoritative to serve the superseded decision as current context while simultaneously surfacing it as a do-not-repeat reversal. Fix: a single shared predicate supersededDecisionIds() (where a superseder counts unless it is itself rejected/phantom, preserving the original if the supersession is declined) is used by both collectReversals (warn side) and the authoritative filter in orient.ts and memory.ts (exclude side), ensuring the two surfaces can never disagree, including in the pre-consolidation window.

**Consequences:** A superseded-but-still-active decision is now withheld from pendingDecisions/recall authoritative and surfaced only under reversals. The superseding decision stays authoritative. No LLM consolidation required for supersession to take effect.

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

### Spec-store binding resolves declared targets by name against the federation registry

**Status:** Approved
**Date:** 2026-06-21
**ID:** c6e36101

A spec-store binding adds an optional OpenLoreConfig.specStore block { name, path, targets[], references? } where targets/references are NAMES that must match entries already in the federation registry (.openlore/federation.json). Resolution and index-state reuse the federation registry verbatim (loadRegistry/listRepos/evaluateRepoState), so the binding adds no new index machinery — it is a thin declarative layer over the shipped index-of-indexes. The health check is read-only and returns conclusion-shaped findings with stable codes (store-path-missing, target-unresolved, target-missing, index-missing, index-stale, reference-missing); it never throws and never blocks. The MCP tool spec_store_status follows the federation_status precedent: present in the full TOOL_DEFINITIONS surface and additionally in the opt-in federation preset, kept out of minimal/navigation/memory.

**Consequences:** Using a spec-store binding requires the target repos to also be registered via `openlore federation add`; a declared name with no registry entry surfaces as a target-unresolved finding with a pasteable remediation rather than an error. Tool count rises 60→61, requiring updates to the count-guarded docs and the --preset help string. Future working-set and impact-certificate tools will extend this binding.

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

> Status: Implemented (change: add-finding-enforcement-policy, 2026-06-23)

Every governance finding source (the decisions gate, the pre-flight blast-radius guard, the change impact
certificate, and the stale-decision-reference check below) SHALL emit each finding carrying a stable,
documented `code` and an intrinsic `severity`. The `code` SHALL be stable across releases so a declared
`enforcement.policy` can name it; the `severity` SHALL be owned by the emitting source and SHALL NOT be
overridden by the enforcement policy. Findings SHALL be shaped so a single enforcement-class resolver can
govern findings from all sources uniformly.

> Implemented as the `GovernanceFinding` shape + the `FINDING_CODE_REGISTRY` catalogue in
> `enforcement-policy.ts`. The blast-radius orphan patterns and the impact-certificate per-severity
> surface codes are registered so their legacy `block: [...]` configs lower onto the unified policy.

#### Scenario: A finding exposes the fields the policy needs

- **GIVEN** any governance finding emitted by any source
- **WHEN** the finding is inspected
- **THEN** it carries a stable `code` and an intrinsic `severity`, sufficient for the enforcement-class
  resolver to classify it without consulting the source

#### Scenario: Existing per-surface block sugar maps onto the unified policy

- **GIVEN** a repository that previously expressed opt-in blocking through a per-surface `block: [...]`
  config
- **WHEN** the unified enforcement policy resolves that surface's finding codes
- **THEN** the resolved classes match the prior `block: [...]` intent, so the per-surface sugar is a thin
  equivalent of, and is superseded by, the unified policy

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
