# Tasks — modularize the call-graph builder

## Spec (this change)
- [x] `analyzer` spec: ADD `StableCallGraphBarrel` requirement (extraction preserves public import surface + behavior)

## Implementation (taken in safe slices, behind the stable barrel)
- [x] Capture a byte-level graph snapshot as the before/after regression oracle — a multi-language `CallGraphBuilder.build()` run + the moved pure helpers, serialized canonically and SHA-256'd. Strengthened for the extract slice to also serialize each node's `docstring` + `signature` (with a JSDoc'd TS fn, an exported async fn, and a Python docstring/annotated-signature in the fixture, so both moved functions are exercised across languages). Current baseline `58107ac0…`.
- [x] **Slice 1:** Extract `call-graph-types.ts` (types, edge model, distance helpers, layer helpers). call-graph.ts 5,425 → 5,150 lines.
- [ ] **Slice 2:** Extract `call-graph-nodes.ts` (ensureUniqueNodeIds, materializeCfgByNodeId, findEnclosingFunction, linkCodeToInfra)
- [x] **Slice 3:** Extract `call-graph-extract.ts` (extractDocstringBefore, extractDeclaration) — taken before slice 2 as the safest small slice (two pure string-scanning helpers, file-internal, zero deps). call-graph.ts 5,150 → 4,951 lines. NOT re-exported (they were never on the public surface — imported back only).
- [ ] **Slice 4:** Extract `call-graph-dispatch.ts` (dedupeOverlappingCalls, synthesizeJavaSuperCalls, safeQuery + dispatch synthesis)
- [ ] **Slice 5:** Extract `grammar-loader.ts` (grammar cache/load, warnUnavailable, __resetGrammarCacheForTests)
- [x] Re-export every moved symbol from `call-graph.ts` so no importer changes — slice 1 re-exports the public type/edge model (`RawEdge`/`CALL_DISTANCE_FALLBACK` kept internal); slice 3 moved file-internal helpers (no re-export needed, surface unchanged); repeated per later slice
- [x] Verify (slices 1 & 3): zero edits to the 155 importers (tsc compiled them all clean); export surface byte-identical (multi-line-aware diff, no add/remove); analyzer + full suite green (279 files / 5534 tests); before/after snapshot byte-identical (slice 1 `131ba4c6…`, slice 3 `58107ac0…`). `stable call-graph barrel` test locks the invariant for later slices.

## Verification
- [x] No new feature, dependency, LLM call, or persisted artifact
- [ ] `openspec validate modularize-call-graph-builder` passes
