# Tasks — optimize-analyze-pipeline-passes

## Implementation
- [x] Extract plain-data class and dynamic-dispatch facts during Pass 1; round-trip them through
      worker structured-clone and the persistent fact cache; do not retain parser trees
- [x] HTTP pass: consume resident in-memory content instead of re-reading builder inputs
- [x] Memoize inferred types by callerNode.id in Pass 2 Strategy 2,
      mirroring cha.ts typesByCaller
- [x] Cache native tree-sitter Query objects per worker/runtime, grammar identity, and source;
      keep WASM queries parse-scoped and disposable
- [x] Replace findEnclosingFunction linear scan with a cached sorted-span index; use Set-based id
      membership in extractors that currently scan the whole node list

## Verification
- [x] Golden graph test covers nodes, every edge (including synthesized provenance), classes, and
      inheritance; serial, worker, and warm-cache lanes remain identical
- [x] Boundary counter test: each newly extracted grammar-backed file parses at most once; native
      queries compile once per cache key; type inference runs once per eligible caller
- [x] Resident HTTP test produces non-empty calls/routes/edges from nonexistent paths with zero
      file opens
- [ ] Full suite green

## Spec
- [x] `analyzer` delta: ADD AnalyzeReusesPassOneFacts
