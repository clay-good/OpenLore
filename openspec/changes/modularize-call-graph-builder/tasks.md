# Tasks — modularize the call-graph builder

## Spec (this change)
- [x] `analyzer` spec: ADD `StableCallGraphBarrel` requirement (extraction preserves public import surface + behavior)

## Implementation (taken in safe slices, behind the stable barrel)
- [x] Capture a byte-level graph snapshot as the before/after regression oracle — a multi-language `CallGraphBuilder.build()` run + the moved pure helpers, serialized canonically and SHA-256'd. Grown per slice to cover each slice's outputs: node `docstring` + `signature` (slice 3), and external nodes across `externalKind` http/db/unknown (this slice). Current baseline `3a118017…`.
- [x] **Slice 1:** Extract `call-graph-types.ts` (types, edge model, distance helpers, layer helpers). call-graph.ts 5,425 → 5,150 lines.
- [ ] **Slice 2:** Extract `call-graph-nodes.ts` (ensureUniqueNodeIds, materializeCfgByNodeId, findEnclosingFunction, linkCodeToInfra)
- [x] **Slice 3:** Extract `call-graph-extract.ts` (extractDocstringBefore, extractDeclaration) — safest small slice (two pure string-scanning helpers, file-internal, zero deps). call-graph.ts 5,150 → 4,951 lines. NOT re-exported (never on the public surface — imported back only).
- [x] **Slice 3b:** Extract `call-graph-external.ts` (classifyExternal + EXTERNAL_* tables + getOrCreateExternalNode) — an additional clean section-banner seam (the proposal's module list is illustrative; this is "EXTERNAL NODE HELPER"). Pure, file-internal; only `getOrCreateExternalNode` is imported back, `classifyExternal`/the tables stay private. call-graph.ts 4,951 → 4,887 lines. Removed the now-unused internal `ExternalKind` import (still re-exported on the barrel).
- [ ] **Slice 4:** Extract `call-graph-dispatch.ts` (dedupeOverlappingCalls, synthesizeJavaSuperCalls, safeQuery + dispatch synthesis)
- [ ] **Slice 5:** Extract `grammar-loader.ts` (grammar cache/load, warnUnavailable, __resetGrammarCacheForTests)
- [x] Re-export every moved symbol from `call-graph.ts` so no importer changes — slice 1 re-exports the public type/edge model (`RawEdge`/`CALL_DISTANCE_FALLBACK` kept internal); slices 3/3b moved file-internal helpers (no re-export needed, surface unchanged); repeated per later slice
- [x] Verify (slices 1, 3, 3b): zero edits to the 155 importers (tsc compiled them all clean); export surface byte-identical (multi-line-aware diff, no add/remove); analyzer + full suite green (279 files / 5534 tests); before/after snapshot byte-identical (slice 1 `131ba4c6…`, slice 3 `58107ac0…`, slice 3b `3a118017…`). `stable call-graph barrel` test locks the invariant for later slices.

## Verification
- [x] No new feature, dependency, LLM call, or persisted artifact
- [ ] `openspec validate modularize-call-graph-builder` passes
