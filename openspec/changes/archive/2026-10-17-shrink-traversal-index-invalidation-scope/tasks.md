# Tasks — shrink-traversal-index-invalidation-scope

## Implementation
- [x] `condensation.ts`: `graphDigest(cg)` over exactly the structure's dependencies — node ids,
      then each edge with a `calleeId` as `(callerId, calleeId, synthesized)` in `cg.edges` order.
      Nothing else, so an unrelated context edit cannot move it and a relevant graph edit cannot
      fail to.
- [x] `artifact-generator.ts`: compute it once and write it as a field of `llm-context.json`;
      stamp the traversal structure with the same value in place of `contextDigest`
- [x] `mcp-handlers/utils.ts`: drop the read-path SHA-256 over the raw artifact; record the key
      straight from the parsed context
- [x] `mcp-handlers/traversal.ts`: key off the recorded value; delete
      `traversalIndexMayBeCurrent` and its two stats
- [x] `artifact-generator.ts`: the write-ordering constraint (structure strictly after context)
      exists only to make the mtime pre-check meaningful — remove it with the pre-check, and drop
      the comment that justifies it
- [x] `mcp-watcher.ts`: state the invariant at `persistContext` and recompute the digest on any
      path that assigns `context.callGraph`
- [x] Guard test: fail CI when a watcher write path assigns the call graph without recomputing
      the digest (the `artifact-write-atomicity.test.ts` source-scan pattern)

## Verification
- [x] Digest sensitivity: changing any node id, edge endpoint, edge order, or synthesized flag
      changes the digest; changing signatures, phases, or any other context field does not
- [x] Flush survival: a `persistContext`-shaped rewrite leaves the structure accepted, proven
      end-to-end through `readCachedContext` → `loadTraversalIndex`, not by unit stub
- [x] Generation invalidation still holds: a structure from another graph is refused, and the
      answer served is the new graph's
- [x] Read-path cost: no hashing on a cache miss; measure a cold `readCachedContext` before and
      after and report both figures (#290 measured 29 ms of SHA-256 to delete)
- [x] Legacy fallback: a context without the field consults no structure and answers identically
- [x] Equivalence unchanged: `npm run verify:reachability` and the full `condensation.test.ts`
      suite pass, since this changes only when a structure is trusted, never what it answers
- [x] Full suite green

## Spec
- [x] `analyzer` delta: ADD TraversalStructureIsKeyedToTheGraphItDescribes
- [x] `mcp-handlers` delta: MODIFY TraversalToolsShareOnePrecomputedRepresentation
