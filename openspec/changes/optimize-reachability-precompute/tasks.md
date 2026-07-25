# Tasks — optimize-reachability-precompute

## Implementation
- [ ] `condensation.ts`: Tarjan SCC (reuse `refactor-analyzer.ts:183-186` machinery) + topo
      order + dense int node-index + CSR forward/backward arrays + per-edge kind/confidence
      mask; deterministic construction (sorted by node id)
- [ ] Persist at analyze (`artifact-generator.ts`) and watcher flush (`mcp-watcher.ts`) under
      the existing atomic-write + attestation discipline; invalidation key shared with the
      context cache
- [ ] Daemon load-once path (coordinate with `optimize-serving-hot-path-caches`' memo slot —
      one loader, keyed on artifact generation)
- [ ] Migrate traversals: `test-impact.ts:151-167`, `coverage-gaps.ts:66-115`,
      `reachability.ts:149-190,272`, `change-footprint.ts:281-299`, `pathfind.ts:110-118`,
      artifact-graph paths in `graph.ts` — index-pointer BFS / condensation walks; delete the
      per-call `buildAdjacency` calls they replace
- [ ] Whole-graph reaches (`find_dead_code`, `report_coverage_gaps`) as topological
      condensation walks with member expansion
- [ ] EdgeStore floor: add `mmap_size` + `cache_size` pragmas in `openDatabase`
      (`edge-store.ts:45-56`); keep `immutable=1` read-only discipline

## Verification
- [ ] Golden equivalence suite: for a corpus of fixture graphs (incl. cycles, synthesized
      edges, disconnected regions), every migrated tool's answer equals the pre-migration BFS
      answer element-for-element
- [ ] Filter parity test: `directResolvedOnly` and confidence-filtered traversals match
- [ ] Generation test: external analyze invalidates a warm daemon's loaded structure before the
      next answer
- [ ] Scale benchmark: synthetic 50k-node graph — report per-call latency before/after for
      `select_tests` and `report_coverage_gaps`; no unmeasured claims
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD ReachabilityStructureIsComputedAtAnalyzeTime
- [ ] `mcp-handlers` delta: ADD TraversalToolsShareOnePrecomputedRepresentation
