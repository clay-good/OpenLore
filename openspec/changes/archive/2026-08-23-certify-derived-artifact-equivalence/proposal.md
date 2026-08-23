# Equivalence certification: every acceleration must be provably answer-identical, and the envelope must be published

> Status: BUILT AND ARCHIVED (2026-08-23; proposed 2026-07-31, external-pattern study). OpenLore has spent 2026-07 adding
> acceleration paths — a parallel extraction pool, a content-hash fact memo, a reachability
> precompute, an incremental watcher lane, an importable graph bundle — each of which can change an
> *answer* while intending only to change a *latency*. The repo's own memory records two
> equivalence traps in a single one of those changes. Today each path defends itself with its own
> ad-hoc test. This change makes answer-equivalence a standing, named invariant with one
> certification matrix, and publishes a certified scale envelope so "fast" stops being an
> unfalsifiable claim. Prior art: engines that treat the derived index as disposable and gate every
> cache and parallel path on byte-identity with the authoritative path.

## Why

Five acceleration paths now stand between the repository bytes and an answer:

| Path | Shipped | Equivalence risk |
|---|---|---|
| Parallel extraction pool | PR #268 | worker-count changes the result |
| Content-hash fact memo | PR #288 | a memo hit serves a fact the current bytes would not produce |
| Reachability precompute (condensation) | PR #290 | precompute and live traversal disagree — memory records **two** such traps in this change alone |
| Incremental watcher lane | ongoing | an incremental update diverges from a full rebuild |
| Graph bundle import | PR #210 | an imported graph answers differently from a locally analyzed one |

Each has tests. What none of them has is a **shared, named invariant** the next acceleration path
inherits automatically. That matters because the risk is structural, not incidental: the whole
class of change is "make it faster without changing the answer," and OpenLore's product is the
answer. An acceleration that silently changes a conclusion is worse than a slow tool, because every
downstream verdict — `select_tests`, `find_dead_code`, `blast_radius`, `report_coverage_gaps` —
inherits the corruption while still presenting itself as deterministic.

Two further gaps compound it:

- **Staleness is not uniformly content-addressed.** PR #288 keyed analyze on content hashes, but
  the serving layer still mixes hash-keyed, mtime-keyed, and event-keyed freshness across the
  daemon, the watcher, the vector index, and the bundle. Time- and event-based staleness can be
  *wrong* in both directions; a content hash cannot. The repo has already paid for this — the
  `--verify`-shaped problem where a size- and mtime-preserving rewrite is invisible to stat.
- **The performance claim has no stated envelope.** OpenLore states latency wins per change but
  never states the repository size at which those numbers hold, nor what happens beyond it. A user
  with a repository ten times the reference size has no way to know whether they are inside the
  tested envelope or off the edge of the map, and a regression at scale is invisible until a user
  reports it.

## What Changes

1. **One named invariant: the derived index is disposable.** The authoritative input is the tuple
   `(repository snapshot, reachable git history, normalized analysis configuration, registered
   analyzer capabilities)`. The repository snapshot is the ordered set of normalized relative
   paths and file bytes selected for analysis; history is the object graph reachable from the
   selected revision; configuration is the validated, default-expanded analysis configuration;
   and capabilities are the registered parser/extractor versions available to the run. Every
   persisted artifact — the graph store, the fact memo, the reachability precompute, the vector
   tables, the keyword corpus sidecar, an imported bundle — is a *rebuildable derived structure*.
   An absent or invalid optional accelerator falls back or rebuilds without changing the semantic
   answer. An unavailable authoritative analysis store fails closed with explicit remediation,
   then converges to the fresh answer after its repair barrier. The existing
   quarantine-on-corruption behavior (PR #240) becomes the general recovery discipline rather than
   one store's special case.

2. **A standing, finite equivalence registry, run in CI as one suite.** Each registered row compares
   the versioned `semantic-answer-v1` projection: stable structural facts and conclusion payloads
   after canonical object-key ordering. Version 1 excludes only `cached`, `cacheState`, `freshness`,
   `freshnessLease`, `generatedAt`, `generationId`, `repair`, `repairStatus`, `servedAt`, and
   `timing`. Filesystem locations, receipts, and every other field remain semantic evidence.
   Operational disclosure is asserted separately; it is never erased merely to make semantic
   answers compare equal.

   | Row | Assertion |
   |---|---|
   | `cold-warm-context` | cold and warm context serving have the same semantic projection |
   | `memo-hit-miss` | a registered memo hit equals recomputation from the same input tuple |
   | `parallel-serial-extraction` | the registered parallel worker count equals serial extraction |
   | `precomputed-live-traversal` | registered precomputed traversal answers equal live traversal |
   | `incremental-full-repair` | after watcher repair converges, edit/add/delete/rename states equal a full rebuild |
   | `imported-local-structural` | a trusted bundle's guaranteed structural payload equals local analysis of the bound input tuple |
   | `bm25-cached-uncached` | registered cached and uncached BM25 answers have the same semantic projection |
   | `function-vector-repair` | corrupt function-vector state fails closed, then a rebuild restores the registered answer |
   | `spec-vector-repair` | corrupt spec-vector state fails closed, then a rebuild restores the registered answer |

   The registry is deliberately finite: it names the worker count, cache mode, query fixtures, and
   structural bundle fields under certification. It does not claim every possible worker count or
   every unregistered serving path. A new acceleration path adds a registered row before it lands.
   Changing the semantic projection is a versioned contract change with reviewed fixtures, not a
   convenient normalization tweak after a failure.

   Watch mode is judged after its documented repair barrier has completed; transient stale-serving
   disclosure during an in-flight repair remains separately tested. Imported parity covers only a
   trusted bundle whose digest, producer trust, source binding, and supported format have passed
   validation, and only the structural payload guaranteed by that format. Dense local indexes and
   machine-local optional enrichments are rebuilt locally and are not falsely required to be
   byte-identical to bundle contents.

3. **Content-addressed freshness, or a disclosed exception.** Every derived artifact SHALL be keyed
   on a hash of the inputs that produced it. Where a hash is impractical and a stat- or event-based
   signal is used instead, the shape it cannot detect SHALL be named in the artifact's disclosure
   and a full-verification path SHALL exist to close it on demand. An undisclosed staleness signal
   is not permitted. The matrix separately asserts each registered artifact's recovery mode and
   operational disclosure, including whether it was rebuilt, quarantined, repaired, or rejected.

4. **A published scale envelope with a required measurement matrix.** OpenLore declares a certified
   repository-size tier with stated latency objectives for cold analyze, warm query, and
   single-file incremental publication. Promoting a tier requires the complete matrix — cold, warm,
   edit, add, delete, rename, peak memory — plus the equivalence matrix above passing at that size.
   Beyond the certified tier the system SHALL still work and SHALL be described as **best-effort**,
   never as certified. Numbers SHALL be labelled measured or extrapolated with the reference
   machine stated, never presented bare.

5. **What this is not.** Not a new optimization. Not a benchmark harness — the sibling
   `add-benchmark-harness-protocol` owns the protocol for *surface* decisions; this owns the
   correctness gates that any optimization must clear and the envelope its numbers are true within.

## Why this is in scope

`analyzer` is the substrate every other domain reads, and `architecture`'s
`UnifiedStructuralSubstrate` makes one graph the shared foundation of both faces. Decision
`c6d1ad07` grounds the entire product in deterministic local computation. An acceleration path that
can change an answer is the most direct possible violation of that decision, and it is currently
guarded per-change rather than by contract.

The five open optimization proposals in the backlog (`optimize-analyze-pipeline-passes`,
`optimize-incremental-and-coldstart-scale`, `optimize-serving-hot-path-caches`,
`prioritize-incremental-closure-budget`, `scale-analyze-to-workspace-shards`) each add another row
to this matrix. Landing the contract first is what makes them cheap to review instead of five
independent correctness arguments.

## Impact

- **Files:** a consolidated equivalence suite (a single named test module that composes the
  existing per-change assertions rather than replacing them), freshness-key audit across
  `src/core/analyzer/pass1-fact-cache.ts`, `condensation.ts`, `index-bundle.ts`,
  `vector-index.ts`, and `src/core/services/mcp-watcher.ts`; a checked-in measurement manifest;
  and an envelope document generated from that manifest.
- **Specs:** `analyzer` — 1 ADDED requirement (disposable derived artifacts + the equivalence
  matrix); `architecture` — 1 ADDED requirement (the certified envelope and its measurement
  discipline).
- **Tool surface:** unchanged. No new tool, no new artifact, no new dependency.
- **Risk:** low in mechanism, potentially high in *findings* — the matrix may fail on day one and
  expose a real divergence in a shipped path. That is the change working as intended; a divergence
  found by a suite is strictly better than one found by a user.
- **Sibling boundaries:** `harden-analyze-rebuild-atomicity` owns write atomicity (that the store
  is never partial); this owns answer-equivalence (that a complete store agrees with the
  authoritative path). `add-perf-regression-counter-budgets` owns per-operation counters; this owns
  the envelope those counters are measured within. `harden-index-store-lifecycle` owns
  corrupt-store quarantine; this generalizes explicit, artifact-specific recovery modes across the
  derived-artifact registry.
