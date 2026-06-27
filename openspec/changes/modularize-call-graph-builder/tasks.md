# Tasks — modularize the call-graph builder

## Spec (this change)
- [x] `analyzer` spec: ADD `StableCallGraphBarrel` requirement (extraction preserves public import surface + behavior)

## Implementation (taken in safe slices, behind the stable barrel)
- [x] Capture a byte-level graph snapshot as the before/after regression oracle — a multi-language `CallGraphBuilder.build()` run + the moved pure helpers (`callDistance`/`layerOf`/`classifyLayerEdge`/`CALL_DISTANCE_COSTS`), serialized canonically and SHA-256'd. Baseline `131ba4c6…`.
- [x] **Slice 1:** Extract `call-graph-types.ts` (types, edge model, distance helpers, layer helpers). call-graph.ts 5,425 → 5,150 lines.
- [ ] **Slice 2:** Extract `call-graph-nodes.ts` (ensureUniqueNodeIds, materializeCfgByNodeId, findEnclosingFunction, linkCodeToInfra)
- [ ] **Slice 3:** Extract `call-graph-extract.ts` (extractDocstringBefore, extractDeclaration)
- [ ] **Slice 4:** Extract `call-graph-dispatch.ts` (dedupeOverlappingCalls, synthesizeJavaSuperCalls, safeQuery + dispatch synthesis)
- [ ] **Slice 5:** Extract `grammar-loader.ts` (grammar cache/load, warnUnavailable, __resetGrammarCacheForTests)
- [x] Re-export every moved symbol from `call-graph.ts` so no importer changes — done for slice 1 (`RawEdge`/`CALL_DISTANCE_FALLBACK` deliberately kept internal, off the public surface); repeated per later slice
- [x] Verify (slice 1): zero edits to the 155 importers (tsc compiled them all clean); export surface byte-identical (multi-line-aware diff); analyzer + full suite green (279 files / 5531 tests); before/after snapshot byte-identical (`131ba4c6…`). `stable call-graph barrel` test added to lock the invariant for later slices.

## Verification
- [x] No new feature, dependency, LLM call, or persisted artifact
- [ ] `openspec validate modularize-call-graph-builder` passes
