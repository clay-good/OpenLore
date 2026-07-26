# Tasks — optimize-reachability-precompute

## Implementation
- [x] `condensation.ts`: iterative Tarjan SCC on dense int ids + topological order +
      CSR forward/backward arrays + per-edge kind/confidence mask; deterministic
      construction (edge-insertion order preserved within each source group, so any
      filtered view reproduces `buildAdjacency`'s `Set` exactly). A condensation PER
      DIRECTION — the two adjacencies are not transposes (an edge from an unindexed
      caller exists only backward)
- [x] Persist at analyze (`artifact-generator.ts`) and watcher flush (`mcp-watcher.ts`)
      through ONE shared writer, under the existing atomic-write + analysis-lock
      discipline; invalidation key = the SHA-256 of the `llm-context.json` bytes the
      structure accompanies
- [x] Load-once path (`mcp-handlers/traversal.ts`): memoized in a `WeakMap` keyed on the
      `SerializedCallGraph` object, so a new generation is a new object is a reload —
      no separate generation bookkeeping that could drift
- [x] Migrate traversals: `test-impact.ts`, `coverage-gaps.ts`, `reachability.ts`,
      `change-footprint.ts`, `pathfind.ts`, `graph.ts` (`trace_execution_path`),
      `env-impact.ts`, `claim-verification.ts`; every production `buildAdjacency` call
      deleted (it survives only as the equivalence oracle the tests pin against)
- [x] Whole-graph reaches (`find_dead_code`, `report_coverage_gaps`) as topological
      condensation walks with member expansion
- [x] EdgeStore floor: `mmap_size` + `cache_size` pragmas in `openDatabase`, fail-soft
      (advisory pragmas must never prevent the store from opening)

## Verification
- [x] Golden equivalence suite (`condensation.test.ts`, 66 tests): randomized graphs with
      cycles, self-loops, duplicate pairs, mixed direct+synthesized on one pair, external
      callees, unindexed callers, and disconnected regions — neighbour lists (order
      included), bounded BFS depths, unbounded reach, delete-mode exclusion, and
      `select_tests`' parent chains all equal the frozen pre-change implementations
- [x] Filter parity: every equivalence case runs under both `directResolvedOnly` settings
- [x] Generation test (`traversal.test.ts`): a structure from another generation is
      refused; an absent / unparseable / wrong-shaped / stale-digest / truncated artifact
      degrades to an in-memory rebuild with identical answers; one structure per
      generation, a new one for the next
- [x] End-to-end on the REAL analyzed graph (`scripts/verify-reachability-equivalence.mjs`):
      7,342 nodes / 18,930 edges, all 15 checks pass under both filters, including the
      persisted artifact's digest binding and rehydrated equivalence
- [x] Scale benchmark (`scripts/bench-reachability.mjs`), 50,000 nodes / 200,000 edges,
      answers asserted equal before timing:
      | conclusion | before | after | |
      |---|---|---|---|
      | `report_coverage_gaps` whole-graph reach | 346.3 ms | 6.4 ms | 54.0x |
      | `select_tests` backward walk (depth 12) | 575.3 ms | 116.7 ms | 4.9x |
      Structure build, paid once per analyze, is 228 ms at that scale; the persisted
      artifact is 1.2 MB against an 11.7 MB `llm-context.json` on this repo
- [x] Full suite green (328 files, 6,326 tests)

## Spec
- [x] `analyzer` delta: ADD ReachabilityStructureIsComputedAtAnalyzeTime
- [x] `mcp-handlers` delta: ADD TraversalToolsShareOnePrecomputedRepresentation
