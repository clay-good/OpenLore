# Stable identity for nested functions: stop collapsing same-named nested functions into one node

> Status: PROPOSED (not started). A first attempt was implemented and **reverted** in PR #213
> (`feat/error-propagation-graph`) because it used an unstable positional discriminator and broke ~30
> tests across six subsystems. This proposal specifies the stable-identity approach those failures
> proved necessary.

## Why

OpenLore keys every function node by `file::name` (or `file::Class.name`) and aggregates nodes into an
id-keyed map (`allNodes.set(node.id, node)` in `call-graph.ts`). Two functions that resolve to the
same id therefore **collapse to one node** — last-write-wins — silently dropping a real function and
merging its edges, fan-in/out, and complexity into its twin.

The collapse is correct for some shapes (see the scope contract) but WRONG for a **nested function**: a
named `function helper(){}` declared inside one method and another `function helper(){}` inside a
second method (or a nested `helper` colliding with a top-level `helper`) are distinct symbols. Today
they merge:

```ts
function helper() {}                 // file::helper
class A {
  m1() { function helper() { a(); } }  // also file::helper  → collapses
  m2() { function helper() { b(); } }  // also file::helper  → collapses
}
// Result: ONE `file::helper` node; m1's and m2's helpers and their edges (a, b) are merged or lost.
```

The dropped twin is invisible everywhere: a function reachable only through it looks dead
(`find_dead_code` false positive), its callers vanish from `analyze_impact`, and
`analyze_error_propagation` cannot trace exceptions through it. This is pre-existing and affects every
language (all extractors share the id scheme). It surfaced while building `this.`/`super.` resolution
(PR #213): resolving intra-object calls made nested-function nodes load-bearing, exposing the merge.

## What changes

Give a genuinely-nested function a **stable, unique id** by qualifying it with its enclosing-scope
chain — NOT a byte offset. Concretely, an id like:

```
file::A.m1/helper        // helper nested in A.m1
file::A.m2/helper        // helper nested in A.m2  (distinct, stable)
file::outer/helper       // helper nested in a top-level function `outer`
```

The qualifier is the enclosing function/method's own (already-stable) id segment, so the nested id is
**stable across edits**: inserting an unrelated line above does not change it (unlike a byte offset,
which shifts and makes the node read as removed+added on every diff).

1. **Disambiguate only byte-CONTAINED nested functions.** A node is re-keyed only when another
   function node strictly contains its span. Sibling collisions (re-assignment, container homonyms)
   are left collapsed (scope contract).
2. **Run at extraction, before call-extraction.** `rawEdge.callerId` is a string baked at extraction
   time via `findEnclosingFunction`, so the unique id must exist before the call loop runs — a shared
   helper invoked in each extractor (or in the shared `dedupeOverlappingCalls`) between node-building
   and call-building. A central post-pass in `build()` cannot re-associate the already-stringified
   `callerId`s.
3. **Derive `stableId` from the qualified identity** so scip export, structural-diff, impact
   certificate, and anchoring see a stable symbol that round-trips across body edits and file moves.
4. **Secondary discriminator for the rare in-scope twin.** Two same-named functions nested in the SAME
   enclosing scope get a deterministic ordinal (`…/helper`, `…/helper#2`) by document order — still
   stable as long as the enclosing scope's earlier structure is unchanged.

## Decision

- **Stable, not positional.** The discriminator is enclosing-scope qualification, never `@byteOffset`.
  The PR #213 attempt used `name@startIndex`; it worked functionally but was unstable across edits and
  broke `structural-diff`, `impact-certificate`, `stable-id`, and anchoring, which require identity to
  survive edits. This is the load-bearing decision.
- **Contained-only.** Re-key a node only if another function node strictly contains it. This preserves
  the deliberate sibling collapses below and confines churn to genuinely nested functions.
- **Extraction-time, per-extractor (shared helper).** Dictated by `rawEdge.callerId` being a string
  set during extraction. One shared helper, called in every language extractor before its call loop.

## Scope contract — do not break these things

These collapses are INTENTIONAL and pinned by existing tests. The change MUST preserve them:

- **Re-assigned member → one node.** `obj.fn = function(){}; obj.fn = function(){}` stays a single
  `file::obj.fn` node (`call-graph.test.ts` — "collapses a re-assigned member … no duplicate
  explosion"). These are siblings, not nested, so the contained-only rule already preserves them.
- **Same-file container homonym → one node.** `namespace A { class Config { load } }` vs
  `namespace B { class Config { load } }` both map to `file::Config.load` and collapse to one node
  (`scip/stable-id.test.ts` — "completeness limit, not a wrong resolution"). Siblings → preserved.
- **Identity stable across edits.** A nested function MUST NOT appear as removed+added in
  `structural_diff` / `change_impact_certificate` when unrelated code shifts. (This is why the
  discriminator must be scope-based, not positional.)
- **`stableId` round-trips.** A nested function's `stableId` MUST be unchanged across a body edit and a
  file move, exactly as top-level symbols are today (`scip/stable-id.test.ts`).
- **No regression in the six identity-bearing subsystems:** `structural-diff`, `impact-certificate`,
  `stable-id`, `scip-export`, `cross-service-topology`, anchoring (`decisions/anchor-*`).

## Out of scope (deferred)

- **Anonymous nested functions** (callbacks with no name) — they get no id today; unchanged.
- **Cross-file homonyms** (same name in different files) — already distinct by `file::`; unchanged.
- **Re-attributing the merged metrics retroactively** — this change prevents future merges; it does
  not reprocess historical artifacts beyond a normal re-analyze.

## Implementation status

Proposed. The PR #213 attempt (helper `ensureUniqueNodeIds` + per-extractor insertion + shared
`dedupeOverlappingCalls` path) is a working scaffold for items 1–2, but it used the unstable positional
discriminator and was reverted. This proposal replaces that discriminator with scope qualification and
adds the `stableId` integration (item 3) and the scope-contract guarantees, which the attempt lacked.
