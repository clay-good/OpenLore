# Every reachability conclusion re-runs BFS over adjacency rebuilt for that call

> Status: PROPOSED (2026-07-23, competitive substrate sweep). The substrate's signature
> conclusions — which tests reach this change, what has no reaching test, what dies if X is
> deleted, what is this diff's blast radius — are all reachability questions, and every one of
> them re-answers from scratch at tool-call time: rebuild `Map<string,Set>` adjacency, run an
> (often unbounded) BFS with an O(n) `queue.shift()`, throw the work away. The graph only
> changes at analyze/flush; reachability structure can be computed once there and served as
> lookups. Prior art: the reachability-index literature (SCC condensation + ordered labeling —
> GRAIL/FERRARI/PReaCH lineage, https://arxiv.org/html/2311.03542) and the general
> "resolve at index time, not query time" discipline of the fast-indexer field. Sibling
> boundary: `optimize-serving-hot-path-caches` CACHES what today's handlers build (memoized
> adjacency, artifact reads); this change REPLACES what is built — a compact precomputed
> traversal structure. Coordinate; if the sibling ships first, its memoized adjacency becomes
> this change's load path.

## The gap

- **Per-call rebuild, per-call BFS, everywhere.** `buildAdjacency`
  (`src/core/services/mcp-handlers/graph.ts:75-98`) constructs `nodeMap`/`forward`/`backward`
  Maps of Sets per invocation for: `select_tests` (`test-impact.ts:151`, BFS `:155-167`),
  `report_coverage_gaps` (`coverage-gaps.ts:115`, **unbounded** `reachAll` `:66-84`),
  `find_dead_code` (`reachability.ts:190`, **unbounded** `reachableFrom` `:149-168`, delete-mode
  `:272`), `change_footprint`/`blast_radius` (`change-footprint.ts:281-299`), `find_path`
  (`pathfind.ts:110-118`). Queues are arrays drained with `queue.shift()` (O(n) per pop,
  `graph.ts:107-118`); `get_subgraph`/`analyze_impact` instead walk the DB one SQL batch per
  level (`graph.ts:127-164`, `:433-437`, `:592-649`).
- **No precomputation exists.** No topological order, condensation, or reachability structure
  is computed at analyze time — confirmed by search; Tarjan SCC exists in-tree but only to
  report refactor cycles (`src/core/analyzer/refactor-analyzer.ts:183-186`, consumed at
  `artifact-generator.ts:1205`), never for serving.
- **The store's floor is unset.** `EdgeStore` opens `node:sqlite` with WAL +
  `synchronous=NORMAL` + `busy_timeout` only (`edge-store.ts:45-56`) — no `mmap_size`, no
  `cache_size` — so even the DB-backed traversals pay avoidable page-fault cost.
- At today's 3k nodes this is milliseconds; at the 50k-function scale OpenLore advertises, a
  per-call O(N+E) rebuild plus unbounded quadratic-drain BFS turns the flagship conclusions
  into the slowest tools on the surface.

## What changes

1. **Analyze/flush-time condensation.** After edge resolution, compute SCC condensation
   (reusing the in-tree Tarjan) and a topological order of the condensation DAG over resolved
   call edges; persist alongside the graph artifacts under the same atomic-write + attestation
   discipline.
2. **One compact traversal structure, shared by all traversal handlers.** Nodes map to dense
   integer ids; forward and backward adjacency serialize as CSR-style typed arrays
   (offsets + targets), with a parallel per-edge kind/confidence mask so existing filters
   (e.g. `directResolvedOnly` skipping `synthesized`, `graph.ts:89`) remain expressible. The
   warm daemon loads it once per artifact generation (same invalidation key as the context
   cache) and every reachability tool traverses it — index-pointer BFS on int arrays, no Maps,
   no Sets, no `shift()`.
3. **Unbounded reaches become condensation walks.** `find_dead_code` and
   `report_coverage_gaps` whole-graph reaches run on the condensation DAG in topological order
   (linear, allocation-free); member expansion recovers node-level answers exactly.
4. **Set the store floor.** Add `mmap_size` and `cache_size` pragmas to `openDatabase` with
   the read-only `immutable=1` discipline already established (`substrate-status` precedent).
5. **Conclusion shapes unchanged.** Every tool returns exactly today's payloads; the only
   observable change is latency. Equivalence is pinned by golden tests: precomputed answers ==
   per-call BFS answers on the same artifact.

**Deliberately NOT borrowed** from the reachability-index literature: no interval/2-hop label
maintenance (GRAIL/FERRARI-class labeling pays off at orders of magnitude more nodes and adds
an invalidation liability the condensation walk doesn't have). If profiling at real monorepo
scale ever shows condensation walks insufficient, labeling is a follow-up proposal, not this
one.

## Why this is in scope

Reachability is what OpenLore *is* — `select_tests`, `blast_radius`, `find_dead_code`, and
`report_coverage_gaps` are the conclusions the README leads with. Serving them as precomputed
lookups is the same doctrine the tool surface already follows ("conclusion tools return the
computed answer") applied one layer down, and it is the load-bearing prerequisite for the
per-edit verdict loop (`add-edit-loop-breakage-verdict`) staying sub-second.

## Impact

- Files: new `src/core/analyzer/condensation.ts` (Tarjan reuse + topo order + CSR build),
  `artifact-generator.ts` (persist), `mcp-watcher.ts` (rebuild on flush),
  `mcp-handlers/graph.ts` + `test-impact.ts` + `coverage-gaps.ts` + `reachability.ts` +
  `change-footprint.ts` + `pathfind.ts` (traverse the shared structure),
  `edge-store.ts:45-56` (pragmas).
- Specs: `analyzer` — 1 ADDED (ReachabilityStructureIsComputedAtAnalyzeTime); `mcp-handlers` —
  1 ADDED (TraversalToolsShareOnePrecomputedRepresentation).
- No new tool; no payload change. Risk: medium — divergence between the precomputed structure
  and the artifact graph is the hazard; both share one invalidation key and the golden
  equivalence tests make divergence loud. Coordinate with `optimize-serving-hot-path-caches`
  (overlapping files; complementary layers).
