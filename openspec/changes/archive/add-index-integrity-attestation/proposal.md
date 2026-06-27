# Index integrity attestation: a deterministic self-check that degrades loudly, never serves a half-built graph silently

> Status: IMPLEMENTED (2026-06-24, PR feat/index-integrity-attestation). Part of the
> `STRUCTURAL-CONTEXT-PATTERNS.md` set. Adds a deterministic post-build plausibility/integrity check
> over the persisted graph index and a queryable **attestation** of its result. Extends the existing
> "never present absence as current fact" persistence ethos (`architecture` spec) from the
> memory/decision stores to the structural graph itself. No new dependency, no LLM, no new MCP tool.
>
> **As-built deltas from the original draft (both tightening soundness):** (1) the attestation records
> no parse-failure count — failed files contribute no nodes, so the production counts account for them
> implicitly, and fabricating a number would violate honesty-over-coverage; (2) the content digest is a
> build-determinism + tamper-evidence stamp only, NOT a load-time verdict driver, because the
> incremental watcher legitimately mutates the store between full builds and a digest-equality load
> check would false-positive on every incremental update. Schema version drives `mismatched`; the
> persisted-vs-committed count ratio drives `degraded`. The spec delta reflects the as-built design.

## Why

OpenLore already refuses to lie about its *stores*: a torn write is prevented atomically
(`DurableAtomicStorePersistence`), and a corrupt store is quarantined and signaled rather than
silently replaced by an empty one (`CorruptStoreQuarantineNotSilentEmpty`) — because "silently losing
persisted memory presents absence as current fact." The structural graph index — the artifact under
`.openlore/analysis/` that every navigation, blast-radius, and reachability tool reads — has no
equivalent guarantee. If a build is interrupted, runs out of memory partway, hits a parser that bails
on a subset of files, or persists a graph from an older schema, the index can end up **plausibly
shaped but materially incomplete**: it loads, it answers, and its answers are quietly wrong. An agent
that asks "what calls this?" or "is this dead?" over a half-built graph gets a confident, false
conclusion — the exact failure mode OpenLore's conclusion-tool posture is supposed to prevent.

The symptom is most dangerous for the *negative* conclusions OpenLore is trusted for: `find_dead_code`
("nothing reaches X"), `select_tests` ("these are all the reaching tests"), `analyze_impact` ("this is
the blast radius"). Each is only sound if the index is complete. A missing 30% of edges turns "dead"
into "looks dead to a broken index."

A peer system guards against exactly this with a cheap post-build check: after writing the graph, it
compares what it *committed in memory* to what *landed on disk*, and if the persisted count falls
below a ratio of the built count, it reports the index as **degraded** rather than **ready** — with a
checkpoint-and-recount retry first. We adopt the principle, generalized: a deterministic integrity
attestation computed at build time and re-checkable at load time, surfaced to agents so that an
answer derived from a degraded index is *labeled*, never presented as complete.

## What changes

1. **A build-time integrity attestation.** When an analysis finishes and the graph is persisted, the
   system computes a deterministic **attestation record** capturing what a healthy index of this repo
   should look like: the schema version, counts of the primary artifacts produced during extraction
   (files parsed, functions, edges, classes), the count of files that failed to parse, and a content
   digest of the persisted graph. The attestation is written alongside the index.

2. **A plausibility verdict: `healthy` | `degraded` | `mismatched`.** The attestation carries a
   deterministic verdict computed from the build, not a heuristic guess:
   - `healthy` — the persisted artifact counts match what extraction committed (within the exact,
     parser-failure-accounted reconciliation), at the current schema version.
   - `degraded` — the persisted graph is materially smaller than what extraction committed (the
     persisted-to-committed ratio falls below a fixed floor), after a checkpoint-and-recount retry —
     i.e. the build did not fully land. This is the half-built-graph case.
   - `mismatched` — the on-disk index was built at a different schema version, or its content digest
     does not match its attestation, i.e. it cannot be trusted as-is.

3. **Load-time re-check, and the no-silent-degradation contract.** On load, the system re-checks the
   index against its attestation (schema version + digest). A `degraded` or `mismatched` index SHALL
   NOT be silently served as if complete: the system emits a recoverable signal and the condition is
   visible to callers. Consistent with the store ethos, the remedy is to *report and recover* (trigger
   or recommend a clean re-analyze), never to present the incomplete graph's negative answers as fact.

4. **Attestation visible to agents (honesty over confidence).** The integrity verdict is queryable —
   surfaced on the existing health/status path and attached to the conclusion tools whose soundness
   depends on completeness. When the index is not `healthy`, the affected conclusions (`find_dead_code`,
   `select_tests`, `analyze_impact`, reachability) SHALL carry the degraded verdict in their existing
   confidence-boundary/staleness disclosure, so "looks dead to a broken index" is never returned as
   "dead." This reuses the `confidence-boundary` disclosure channel rather than adding a new one.

5. **Determinism.** The attestation is integer counts plus a content digest over a deterministic build;
   it is byte-identical across re-analyses of a fixed repository state. The verdict is a pure function
   of the attestation and the on-disk index — no clock, no model, no sampling.

## Decision

**A reconciliation check, not a re-extraction.** Integrity is verified by reconciling persisted counts
and a content digest against the attestation the build already produced — cheap, deterministic, O(index
size). It deliberately does *not* re-run extraction to compare graphs (that would double build cost and
defeat the point). The check answers "did the build I just ran land intact and at the right schema?",
not "is the graph semantically correct" — the latter is unfalsifiable cheaply and out of scope. The
ratio floor distinguishing `healthy` from `degraded` is a fixed, documented constant with a small-repo
exemption (a tiny repo's counts are too small for a ratio to be meaningful), mirroring how the existing
store guards treat legacy/edge cases.

## Scope contract — do not break these things

This change must NOT:
- Re-run or duplicate extraction to verify the graph. Reconciliation only.
- Change the graph schema or any conclusion's result shape beyond attaching the integrity verdict to
  the *existing* confidence-boundary/staleness disclosure.
- Silently serve a `degraded` or `mismatched` index as complete, or silently substitute an empty one —
  it reports and recovers, per the store ethos.
- Block by default. Like the other advisory surfaces, a degraded verdict is surfaced, not enforced;
  any gating is opt-in.
- Use a clock, a model, or sampling. The attestation and verdict are deterministic.

## Out of scope (deferred)

Auto-repair of a degraded index beyond triggering/recommending a clean re-analyze; semantic
verification of graph correctness; per-file integrity attestation (this is index-level); and an
enforcement-policy code that *blocks* on a degraded index (advisory first; a `degraded-index` finding
could later be registered in `FINDING_CODE_REGISTRY` for opt-in enforcement, but that is a separate
change).

## Implementation status

SHIPPED. Implemented in `src/core/analyzer/index-attestation.ts` (attestation shape, `computeAttestation`,
`reconcile`, atomic `writeAttestation`/`readAttestation`), written on build in
`artifact-generator.ts:writeEdgesToSQLite`, reconciled at load in
`mcp-handlers/utils.ts:readCachedContext` (verdict attached to `CachedContext.integrity`, recoverable
signal emitted on non-healthy), and surfaced via `confidence-boundary.ts` (`assembleBoundary` gains an
`integrity` part feeding the conclusion tools `find_dead_code`/reachability, `select_tests`,
`analyze_impact`, path tracing) and `health-map.ts`. EdgeStore gained `countFiles`/`countEdges`/
`countClasses`/`getSchemaVersion`/`checkpoint` and an exported `SCHEMA_VERSION`.

**Adversarial hardening pass 1 (post-review, same PR):**
- **Fail closed on a malformed attestation.** `readAttestation` now validates the `committed` counts are
  finite numbers and bounds the file size before reading (untrusted-artifact safety). Without the numeric
  check a `committed: {}` made the ratio `NaN` and `NaN < floor` `false` — silently fabricating `healthy`,
  the exact failure the feature prevents. Now treated as unverifiable.
- **Incremental watcher keeps counts in lockstep.** The build-time attestation snapshots the full build;
  the watcher legitimately deletes nodes/edges between builds. Left alone, a bulk deletion could drive the
  persisted counts below the build-time baseline and falsely report `degraded`. The watcher now calls
  `refreshAttestationCounts` after its store mutations (cheap recount; build-time digest carried forward),
  so the verdict reconciles against the *current* store. Verified on this repo: a 1,700-node deletion
  stays `healthy` after refresh.

**Adversarial hardening pass 2 (deeper review, same PR):**
- **Refresh must not mask a schema mismatch.** `refreshAttestationCounts` previously re-stamped the
  attestation's `schemaVersion` to the current value. In the window after a schema-bump wipe (when the
  store reports the new schema but the on-disk attestation is still old), a watcher batch would silently
  "upgrade" the attestation — masking the `mismatched` verdict the feature exists to surface. It now
  carries the existing schema forward and **refuses to refresh across a schema boundary** (leaves the
  attestation untouched so the load still sees `mismatched`). Dogfooded: an old-schema attestation over a
  current-schema store stays `mismatched`, not silently healthy.
- **Passive WAL checkpoint on the read path.** The checkpoint-and-recount retry ran
  `wal_checkpoint(TRUNCATE)` inside `readCachedContext` (a read path), which can block up to `busy_timeout`
  on a concurrent writer — and the degraded case correlates with a concurrent `analyze`. Switched to
  `wal_checkpoint(PASSIVE)`, which folds a lagging WAL without waiting on writers; degraded detection still
  works (dogfooded).
- **Verdict is a load-time/cache-miss property.** Documented that the verdict is computed on a cold load
  and carried on the context; the watcher keeps the attestation in lockstep so a cold reconcile of a
  watcher-updated index stays `healthy` (dogfooded against a real `watcher.handleChange`).

Verified by: unit tests over the pure functions (`index-attestation.test.ts` — counts, determinism,
order-independent digest, the three verdicts, small-repo + ratio-floor boundaries, `committed.edges===0`
guard, read/write round-trip, foreign-version + malformed + oversized rejection, `refreshAttestationCounts`
including its **schema-boundary refusal**); a **build-side pipeline** test driving the real
`writeEdgesToSQLite` and asserting the attestation counts the internal/non-test population and reconciles
healthy with the store it wrote (`artifact-generator-attestation.test.ts` — the regression guard for the
internal-vs-external count bug); a load-path + agent-surface e2e (`index-integrity-load.test.ts` — healthy /
degraded partial-persist / mismatched schema / unverifiable-legacy / db-absent / **malformed-on-disk**, plus
`find_dead_code`, `analyze_impact`, `select_tests` and `get_health_map` carrying the verdict and the
recoverable telemetry signal, all driving real handlers); the confidence-boundary wiring
(`confidence-boundary-integrity.test.ts`); and direct EdgeStore method tests (`edge-store.test.ts`).
Dogfooded on this repo: a full `analyze` writes a deterministic attestation (byte-identical across two
builds), the live index loads `healthy` (2534/2534 functions), a node-deleted clone loads `degraded`, a
schema-bumped attestation loads `mismatched`, a malformed/oversized attestation loads `unverifiable`, and
the watcher-deletion+refresh path stays `healthy`. Dogfooding caught a real bug pre-merge — the attestation
initially counted external nodes while the load recounts internal-only, falsely flagging the healthy index
`degraded`; fixed to count the same population.
