# The traversal structure is invalidated by edits it does not depend on

> Status: PROPOSED (2026-07-26, follow-up from PR #290 `optimize-reachability-precompute`).
> The precomputed reachability structure is a pure function of the call graph, but it is keyed
> to the bytes of the whole `llm-context.json`. A watcher flush that patches only signatures
> therefore invalidates it, and the read path pays a SHA-256 over a multi-MB artifact on every
> cold read just to discover that. Both costs were measured during #290 and both are avoidable:
> carry a digest OF THE GRAPH in the context, so the reader gets the key for free from the JSON
> it has already parsed. This is the item #290's PR body named as the remaining design gap.

## The gap

- **The key is over-broad.** `contextDigest` (`condensation.ts:707`, checked at `:851`) is
  `sha256(llm-context.json)` (`condensation.ts:60`). The structure depends on strictly less than
  that: the node id set, and the ordered `(callerId, calleeId, synthesized)` of every edge with a
  `calleeId`. Signatures, phases, and every other context field are irrelevant to it.
- **So a signature-only flush invalidates it.** `persistContext` (`mcp-watcher.ts:905-914`)
  rewrites the context on every flush and provably never assigns `context.callGraph`. The graph
  is identical; the key is not. The structure is then unusable until the next full `analyze`.
- **And the reader pays to find that out.** `readCachedContext` digests the raw artifact on
  every cache miss (`utils.ts:411`) — measured at 29 ms over this repo's 11.7 MB context, against
  a 39 ms in-memory rebuild. That makes persistence roughly break-even at this repo's size and
  only clearly worthwhile at monorepo size.
- **Two mechanisms exist only to contain that.** `traversalIndexMayBeCurrent`
  (`traversal.ts:87`) is a two-stat pre-check added so the post-flush state stops paying the
  digest, and it in turn forces `analyze` to write the structure strictly after the context
  (`artifact-generator.ts:528`). Both are correct, and both are scaffolding around a key that is
  measuring the wrong thing.

## What changes

1. **`analyze` computes a `graphDigest` and puts it IN the context.** A SHA-256 over the
   structure's actual dependencies — node ids, then each usable edge's `(callerId, calleeId,
   synthesized)` in `cg.edges` order — written as a field of `llm-context.json`. Paid once per
   analyze, inside a phase already measured in seconds.
2. **The structure is stamped with that value instead of the artifact digest.** Same
   `payloadDigest` self-integrity check as today; only the generation key changes.
3. **The reader stops hashing.** It reads `graphDigest` out of the context it has already
   parsed — O(1), no crypto on the read path at all — and compares. This is the whole point:
   the key becomes free exactly where it was expensive.
4. **A flush stops invalidating.** `persistContext` round-trips the parsed context, so it
   carries `graphDigest` through unchanged; the structure keeps matching across every
   signature-only flush. `traversalIndexMayBeCurrent` and the write-ordering constraint it
   requires are then removable — they exist only to bound a cost that no longer exists.
5. **The "watcher never changes the graph" invariant becomes load-bearing, so it gets a guard.**
   Any watcher lane that writes `context.callGraph` MUST recompute `graphDigest`. A source-scan
   test (the `artifact-write-atomicity.test.ts` / `serve-descriptor.ts` "no fourth door" pattern)
   fails CI if a lane assigns the graph without it.
6. **Legacy contexts fail safe.** A context with no `graphDigest` records no key, so no
   structure is consulted and the traversal is built in memory — today's behavior.

**Deliberately NOT done:** no re-stamping sidecar (a second file that can desync with the first),
and no reader-side recomputation of the graph digest (O(N+E) hashing on the read path is most of
what this change exists to delete). The digest is produced exactly once, by the process that
already holds the graph.

## Why this is in scope

#290 shipped the measured win — reachability served as lookups, ~60x and ~15x at 50k nodes — but
its persistence layer is break-even at small scale and dead in watch mode, which is the mode the
daemon actually runs in. This makes the persisted structure earn its keep in the common case
rather than only on a cold monorepo, and it deletes two mechanisms rather than adding one.

## Impact

- Files: `artifact-generator.ts` (compute + persist `graphDigest`), `condensation.ts`
  (`graphDigest` helper; stamp and check it in place of `contextDigest`),
  `mcp-handlers/traversal.ts` (drop `traversalIndexMayBeCurrent`; key off the parsed field),
  `mcp-handlers/utils.ts` (drop the read-path SHA-256), `mcp-watcher.ts` (guard + a comment
  stating the invariant), one new guard test.
- Specs: `analyzer` — 1 ADDED (TraversalStructureIsKeyedToTheGraphItDescribes) + 1 MODIFIED
  (ReachabilityStructureIsComputedAtAnalyzeTime, whose artifact-bytes-digest / write-strictly-after
  / mtime-pre-check clauses this change deletes); `mcp-handlers` — 1 MODIFIED
  (TraversalToolsShareOnePrecomputedRepresentation, whose invalidation clause changes).
- Risk: medium-low. The hazard is a future watcher lane mutating the graph without recomputing
  the digest, which would serve a structure for the wrong graph — the one failure mode #290's
  byte-level key made structurally impossible. That trade is the entire substance of this change,
  and item 5 is the mitigation; it should not ship without it.
- No payload change, no new artifact, no new tool. `llm-context.json` gains one field.
