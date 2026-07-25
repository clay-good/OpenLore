# Change set: competitive substrate sweep 2026-07 — faster than the field, more useful than the graph

This directory gained 6 change proposals on 2026-07-23, produced by a three-track research sweep
of the code-intelligence-for-agents field (the current graph-index entrants, the fast-indexing
engineering literature, and the published evidence on what actually improves agent success),
diffed against the existing 141-proposal backlog so every item here is net-new whitespace. Per
project policy, no competing product is named in any proposal; concepts are credited to the
field or to academic sources.

## What the research established

**Positioning is validated.** Every breakout tool of 2025–26 in this category is local-first
with embedded storage over MCP; the server-dependent graph-DB tools stalled on ops friction, and
one team's own tracker records regretting a move OFF an embedded SQLite store. Conclusion-shaped
one-call answers are the convergent adoption winner (published measurement: agents underuse
graph tools that demand query formulation and fall back to grep — https://arxiv.org/pdf/2602.20048),
which is OpenLore's shipped doctrine. Nobody else has symbol-anchored self-invalidating memory,
spec drift, governance findings, or honest-boundary disclosure — the governance face is
uncontested.

**The speed bar is set by three mechanisms** the field converged on, all absent here:
content-hash-keyed per-file memoization (re-index cost proportional to the diff), parallel
per-file parsing, and resolve-at-index-time serving (queries as lookups, not per-call
traversals). The evidence-backed usefulness gaps are span-level localization (agents hit the
right file 60–70% of the time but the right lines only 14–19%; evidence-per-token correlates
r≈0.95 with repair success — https://arxiv.org/html/2606.07297v1) and deterministic per-edit
verification loops (+21–32 pt correctness in feedback-loop studies —
https://arxiv.org/html/2504.06939v2).

## The six proposals

| # | Change | Track | One line |
|---|--------|-------|----------|
| 1 | `optimize-parallel-extraction-pool` | speed | Pass 1 parses serially on one core (`call-graph.ts:3979-4034`, zero workers repo-wide); a worker pool with input-order merge ≈ core-count× on the dominant phase, byte-identical output |
| 2 | `optimize-hash-keyed-analyze` | speed | Batch analyze is skip-all or re-parse-all (`analyze.ts:411-412`); `file_hashes` exists but only the watcher reads it — per-file fact memoization makes analyze O(diff) |
| 3 | `optimize-reachability-precompute` | speed | Every flagship conclusion re-runs BFS over per-call-built adjacency (no condensation/topo/closure exists); precompute at analyze, serve as lookups |
| 4 | `add-span-precise-conclusions` | usefulness | The line-precise substrate (call-site lines, def-use lines) is persisted and then dropped at the conclusion boundary; surface it + a `focus` slice on `get_function_body` |
| 5 | `add-edit-loop-breakage-verdict` | usefulness | The watcher knows about breakage at patch time and says nothing; derive a provable-only per-edit verdict (broken refs, arity, imports, reaching tests), hook-deliverable, advisory |
| 6 | `refine-first-run-partial-serving` | onboarding | First build serves "no index found" for minutes despite significance-ordered (hubs-first) processing; flush partials + completeness receipt, extend the stale-serving contract to absent |

## How they compose

1+2 multiply (parallelize only the diff); 3 is the serving-side floor that keeps 5 sub-second at
scale; 4 and 5 are the two evidence-ranked usefulness levers (localization depth, verification
loop); 6 converts 1+2's speed into the first-contact experience. Cross-references to the
existing backlog are named inside each proposal (`optimize-analyze-pipeline-passes`,
`optimize-serving-hot-path-caches`, `optimize-incremental-and-coldstart-scale`,
`add-incremental-early-cutoff`, `add-symbol-content-hashes`, `add-agent-loop-enforcement-hook`,
`refine-orient-context-budgeting`) — none is re-proposed.

## What was considered and deliberately not proposed

- **Trigram/sparse-ngram literal index** — the literal-text line index shipped
  (`text-line-index.ts`) covers the need at current scale; a posting-list sidecar is the
  monorepo-era follow-up, not now.
- **Reachability interval labeling (GRAIL/FERRARI class)** — condensation walks suffice below
  hundreds of thousands of nodes; labeling adds an invalidation liability (noted as an explicit
  non-goal in proposal 3).
- **LLM-summarized "purpose" embeddings** — the one LLM-at-index-time idea with field evidence,
  but it breaks no-LLM-in-the-hot-path determinism; the lexical equivalent (identifier-aware
  BM25 + symbol boosts) already shipped.
- **Auto-generated context-digest expansion** — published factorial evidence says LLM-generated
  always-injected digests REDUCE agent success at higher cost (https://arxiv.org/pdf/2605.10039);
  the existing `adopt-agent-context-interop` proposal already owns the corrective.
- **Compiler/typecheck in the edit loop** — owned by the opt-in `add-lsp-evidence-tier`;
  proposal 5 stays deterministic-provable-only by design.

Baseline: main @ b1b9023 (v2.1.6), 141 pre-existing changes in this directory.
