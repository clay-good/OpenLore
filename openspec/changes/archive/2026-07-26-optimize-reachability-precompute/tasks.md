# Tasks — optimize-reachability-precompute

## Implementation
- [x] `condensation.ts`: iterative Tarjan SCC on dense int ids + topological order +
      CSR forward/backward arrays + a per-edge mask; deterministic construction
      (edge-insertion order preserved within each source group, so any filtered view
      reproduces `buildAdjacency`'s `Set` exactly). Two subtleties the first cut got
      wrong and the equivalence suite caught:
      - a condensation PER DIRECTION — the two adjacencies are not transposes (an edge
        from an unindexed caller exists only backward);
      - forward emission is POSITION- and FILTER-dependent, because `buildAdjacency`
        grows its forward key set as it walks the filtered edge list — so eligibility
        is resolved per slot into per-filter mask bits, not approximated by a
        whole-graph pre-pass.
- [x] Persist at analyze (`artifact-generator.ts`) under the existing atomic-write +
      analysis-lock discipline; invalidation key = the SHA-256 of the
      `llm-context.json` bytes the structure accompanies. A failed write removes any
      previous structure rather than leaving one nothing can ever use.
- [x] NOT persisted at watcher flush — measured decision, see Verification. That lane
      never assigns `context.callGraph`, so it would rewrite a bit-identical structure
      at +40-53% flush cost (seconds at monorepo scale) while holding the analysis
      lock, for a file the flush's own cache-prime then bypasses.
- [x] Load-once path (`mcp-handlers/traversal.ts`): memoized in a `WeakMap` keyed on
      the `SerializedCallGraph` object, so a new generation is a new object is a
      reload — no separate generation bookkeeping that could drift. Read is
      size-bounded, matching the `ARTIFACT_MAX_BYTES` guard its sibling carries.
- [x] Migrate traversals: `test-impact.ts`, `coverage-gaps.ts`, `reachability.ts`,
      `change-footprint.ts`, `pathfind.ts`, `graph.ts` (`trace_execution_path`),
      `env-impact.ts`, `claim-verification.ts`; every production `buildAdjacency` call
      deleted (it survives only as the frozen reference the tests pin against)
- [x] Whole-graph reaches (`find_dead_code`, `report_coverage_gaps`) as topological
      condensation walks with member expansion — in the unfiltered view. A
      `directResolvedOnly` reach runs an allocation-free CSR walk instead (the
      condensation describes the whole graph; a filtered graph can have strictly finer
      components). Disclosed in the code and in the spec delta rather than claimed away.
- [x] Excluded from `openlore export` bundles, on the vector index's reasoning: a pure,
      millisecond-scale function of the bundled graph is not worth the bundle bytes.

## Verification
- [x] Golden equivalence suite (`condensation.test.ts`, 71 tests): randomized graphs
      with cycles, self-loops, duplicate pairs, mixed direct+synthesized on one pair,
      external callees, and unindexed callers in all four key-creation orderings
      (never-a-callee / out-edge-before / out-edge-after / key-only-via-synthesized) —
      neighbour lists (order included), bounded BFS depths, unbounded reach,
      delete-mode exclusion, and `select_tests`' parent chains all equal the frozen
      pre-change implementations. Confirmed the generator FAILS on the pre-fix code:
      reintroducing the old forward semantics fails every seed, not just the named
      regressions.
- [x] Filter parity: every equivalence case runs under both `directResolvedOnly` settings
- [x] Corruption suite: a single flipped base64 character in ANY persisted array is
      refused (a payload digest over the structure's own bytes), and out-of-range
      indices are refused even when that digest is recomputed (bounds checks on every
      array that addresses another). Before this, 7 of 210 single-character
      corruptions silently changed reachability answers and `neighborIds` could return
      `undefined` — a false "dead code" conclusion.
- [x] Generation test (`traversal.test.ts`): a structure from another generation is
      refused; an absent / unparseable / wrong-shaped / stale-digest / truncated
      artifact degrades to an in-memory rebuild with identical answers; one structure
      per generation, a new one for the next
- [x] End-to-end on the REAL analyzed graph (`npm run verify:reachability`): 7,349
      nodes / 18,973 edges, all 15 checks pass under both filters, including the
      persisted artifact's digest binding and rehydrated equivalence
- [x] Scale benchmark (`npm run bench:reachability`), 50,000 nodes / 200,000 edges,
      answers asserted equal before timing:
      | conclusion | before | after | |
      |---|---|---|---|
      | `report_coverage_gaps` whole-graph reach | 340.8 ms | 6.6 ms | 51.6x |
      | `select_tests` backward walk (depth 12) | 686.0 ms | 114.5 ms | 6.0x |
      Structure build, paid once per generation, is 224 ms at that scale; the persisted
      artifact is 1.1 MB against an 11.7 MB `llm-context.json` on this repo.
- [x] Full suite green (329 files, 6,338 tests)

## Deferred, with the measurement that deferred it

**EdgeStore `mmap_size` / `cache_size` pragmas — attempted, measured, reverted.** Over this
repo's 29 MB store, 8 concurrent handles x (3 count queries + a full edge scan): no pragma
63-74 ms, `mmap_size` only 62-63 ms, `cache_size` only 70-75 ms, both 64-71 ms — all inside
run-to-run noise — while costing +16 MB (cache) to +35 MB (mmap) RSS, repeated per served repo
by the uncapped context cache. The proposal's rationale (page-fault cost on the DB-backed
traversals) may hold at a scale this repo cannot exercise. It is not part of this change and is
not claimed by either spec delta; it belongs to a follow-up that can ship with its own
measurement rather than an unmeasured claim.

## Spec
- [x] `analyzer` delta: ADD ReachabilityStructureIsComputedAtAnalyzeTime
- [x] `mcp-handlers` delta: ADD TraversalToolsShareOnePrecomputedRepresentation
