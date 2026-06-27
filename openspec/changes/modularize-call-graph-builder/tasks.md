# Tasks — modularize the call-graph builder

## Spec (this change)
- [x] `analyzer` spec: ADD `StableCallGraphBarrel` requirement (extraction preserves public import surface + behavior)

## Implementation (later, separate change — NOT in this proposal)
- [ ] Capture a byte-level graph snapshot of a fixture repo as the before/after regression oracle
- [ ] Extract `call-graph-types.ts` (types, edge model, distance helpers, layer helpers)
- [ ] Extract `call-graph-nodes.ts` (ensureUniqueNodeIds, materializeCfgByNodeId, findEnclosingFunction, linkCodeToInfra)
- [ ] Extract `call-graph-extract.ts` (extractDocstringBefore, extractDeclaration)
- [ ] Extract `call-graph-dispatch.ts` (dedupeOverlappingCalls, synthesizeJavaSuperCalls, safeQuery + dispatch synthesis)
- [ ] Extract `grammar-loader.ts` (grammar cache/load, warnUnavailable, __resetGrammarCacheForTests)
- [ ] Re-export every moved symbol from `call-graph.ts` so no importer changes
- [ ] Verify: zero edits to the 155 importers; analyzer suite green; before/after graph snapshot byte-identical

## Verification
- [x] No new feature, dependency, LLM call, or persisted artifact
- [ ] `openspec validate modularize-call-graph-builder` passes
