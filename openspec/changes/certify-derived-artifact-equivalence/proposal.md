# Equivalence certification: every acceleration must be provably answer-identical, and the envelope must be published

> Status: PROPOSED (2026-07-31, external-pattern study). OpenLore has spent 2026-07 adding
> acceleration paths — a parallel extraction pool, a content-hash fact memo, a reachability
> precompute, an incremental watcher lane, an importable graph bundle — each of which can change an
> *answer* while intending only to change a *latency*. The repo's own memory records two
> equivalence traps in a single one of those changes. Today each path defends itself with its own
> ad-hoc test. This change makes answer-equivalence a standing, named invariant with one
> certification matrix, and publishes a certified scale envelope so "fast" stops being an
> unfalsifiable claim. Prior art: engines that treat the derived index as disposable and gate every
> cache and parallel path on byte-identity with the authoritative path.

## The gap

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

## What changes

1. **One named invariant: the derived index is disposable.** Repository bytes plus git history are
   the truth; every persisted artifact — the graph store, the fact memo, the reachability
   precompute, the vector tables, the keyword corpus sidecar, an imported bundle — is a
   *rebuildable derived structure*. Deleting it, or hitting a corrupt or format-outdated one, SHALL
   cost latency only, never correctness. The existing quarantine-on-corruption behavior (PR #240)
   becomes the general rule rather than one store's special case.

2. **A standing equivalence matrix, run in CI as one suite.** Each row asserts byte-identity of the
   *answers*, not of the internals:

   | Row | Assertion |
   |---|---|
   | cold ≡ warm | first query after a cold build equals the same query on a warm store |
   | cached ≡ uncached | every serving path with cache disabled returns identical bytes |
   | parallel ≡ serial | a build at N workers equals a single-worker build, for every N |
   | incremental ≡ full | an incremental update after an edit equals a full rebuild of the edited state |
   | imported ≡ local | an imported bundle answers identically to a local analyze of the same commit |
   | memo-hit ≡ memo-miss | a fact served from the memo equals the fact recomputed from bytes |

   A new acceleration path adds its row before it lands. This is the point: the matrix is where the
   invariant is inherited, so the next change does not re-derive it from scratch.

3. **Content-addressed freshness, or a disclosed exception.** Every derived artifact SHALL be keyed
   on a hash of the inputs that produced it. Where a hash is impractical and a stat- or event-based
   signal is used instead, the shape it cannot detect SHALL be named in the artifact's disclosure
   and a full-verification path SHALL exist to close it on demand. An undisclosed staleness signal
   is not permitted.

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
  `vector-index.ts`, and `src/core/services/mcp-watcher.ts`, and an envelope document generated
  from measured runs.
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
  corrupt-store quarantine; this generalizes its guarantee to every derived artifact.
