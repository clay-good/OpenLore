# Tasks — shrink-traversal-index-invalidation-scope

## Implementation
- [ ] `condensation.ts`: `graphDigest(cg)` over exactly the structure's dependencies — node ids,
      then each edge with a `calleeId` as `(callerId, calleeId, synthesized)` in `cg.edges` order.
      Nothing else, so an unrelated context edit cannot move it and a relevant graph edit cannot
      fail to.
- [ ] `artifact-generator.ts`: compute it once and write it as a field of `llm-context.json`;
      stamp the traversal structure with the same value in place of `contextDigest`
- [ ] `mcp-handlers/utils.ts`: drop the read-path SHA-256 over the raw artifact; record the key
      straight from the parsed context
- [ ] `mcp-handlers/traversal.ts`: key off the recorded value; delete
      `traversalIndexMayBeCurrent` and its two stats
- [ ] `artifact-generator.ts`: the write-ordering constraint (structure strictly after context)
      exists only to make the mtime pre-check meaningful — remove it with the pre-check, and drop
      the comment that justifies it
- [ ] `mcp-watcher.ts`: state the invariant at `persistContext` and recompute the digest on any
      path that assigns `context.callGraph`
- [ ] Guard test: fail CI when a watcher write path assigns the call graph without recomputing
      the digest (the `artifact-write-atomicity.test.ts` source-scan pattern)

## Verification
- [ ] Digest sensitivity: changing any node id, edge endpoint, edge order, or synthesized flag
      changes the digest; changing signatures, phases, or any other context field does not
- [ ] Flush survival: a `persistContext`-shaped rewrite leaves the structure accepted, proven
      end-to-end through `readCachedContext` → `loadTraversalIndex`, not by unit stub
- [ ] Generation invalidation still holds: a structure from another graph is refused, and the
      answer served is the new graph's
- [ ] Read-path cost: no hashing on a cache miss; measure a cold `readCachedContext` before and
      after and report both figures (#290 measured 29 ms of SHA-256 to delete)
- [ ] Legacy fallback: a context without the field consults no structure and answers identically
- [ ] Equivalence unchanged: `npm run verify:reachability` and the full `condensation.test.ts`
      suite pass, since this changes only when a structure is trusted, never what it answers
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD TraversalStructureIsKeyedToTheGraphItDescribes
- [ ] `mcp-handlers` delta: MODIFY TraversalToolsShareOnePrecomputedRepresentation
