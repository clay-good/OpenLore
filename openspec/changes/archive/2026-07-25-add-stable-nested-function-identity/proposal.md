# Stable identity for nested functions: stop collapsing same-named nested functions into one node

> Status: IMPLEMENTED (branch `feat/stable-nested-function-identity`, off main). `npm run build` clean;
> `vitest run src examples` green (273 files / 5379 tests). A first attempt in PR #213 used an unstable
> positional discriminator and was reverted; this delivers the stable enclosing-scope approach. The
> live build re-keys genuine nested collisions only (e.g. two `cleanup` arrows in `startMcpServer`, two
> `getDiff` arrows in `extractFromDiff`) — a handful on the OpenLore repo, no churn elsewhere.

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
3. **Same-id container = same function (not nested).** An `export function f` / decorated definition is
   matched TWICE — the `export_statement`/`decorated_definition` wrapper byte-contains the inner
   declaration, both carrying id `file::f` — and the system relies on these collapsing by id. The
   re-key therefore fires ONLY when the containing function has a DIFFERENT id; a same-id container is
   the same logical symbol and is left to collapse. (This guard is what kept the change green — without
   it every `export`/decorated function spuriously split.)
4. **Secondary discriminator for the rare in-scope twin.** Two same-named functions nested in the SAME
   enclosing scope get a deterministic document-order ordinal (`…/helper`, `…/helper#2`).
5. **Re-key the CFG side-table with the node.** The intraprocedural CFG overlay is built per-function
   in the same extraction loop; keying it by the bare id would lose one of two colliding nested CFGs to
   last-write-wins and orphan the survivor under the pre-disambiguation id (no node would carry it).
   `materializeCfgByNodeId` collects each CFG keyed by the function's start byte (unique per AST node,
   unchanged by re-keying) and re-attaches it to the FINAL node id after disambiguation, in every
   cfg-bearing extractor. So `analyze_error_propagation` / def-use resolve a re-keyed nested function's
   overlay by its node id — exactly the nodes this change makes addressable.
6. **Don't drop nested twins in the shared query-spec extractor.** `extractByQueries` (C#/Kotlin/Scala/
   PHP/Lua) dedups colliding ids at extraction (`if (nodes.some(n => n.id === id)) continue`) to collapse
   multi-clause definitions / overloads — but that ran BEFORE `ensureUniqueNodeIds` and silently dropped
   a genuinely nested twin, so those languages kept merging nested functions (the exact bug, in a
   different language tier). The dedup now keeps a colliding node that is byte-contained in a different-id
   function (a real nested function → survives to be re-keyed) and still collapses a true same-scope
   overload. The enclosing function is matched before its nested child, so the container is present at
   the decision point. (C# nested twins now split with CFG; Kotlin/Scala split with no CFG, as those
   have no CFG overlay; C#/Kotlin overloads still collapse — all verified.)
7. **Resolve incoming calls by lexical scope.** Splitting the twins is only half the fix: the same-file
   call resolver picked the FIRST same-named candidate, so once two nested `validate`s became distinct
   nodes, `processB()`'s `validate()` misrouted to `processA`'s. The resolver now prefers the twin
   byte-NESTED in the caller (narrowest, since an inner def shadows the name), treats a self-named
   candidate as recursion (binds to the caller — a nested `visit(){ … visit() … }` recurses, it does
   not jump scopes), and otherwise keeps the first-same-file fallback. Localized to the same-file
   strategy; a no-op when there is a single candidate. Verified end-to-end via `analyze_error_propagation`
   (processB now reports its own `TypeError`, not processA's `RangeError`).
8. **`stableId` scope.** The PATH id (`file::…`) is now unique and stable for nested functions — the
   structural fix every node-id and edge consumer needs. The content-addressed `stableId`
   (`scip/moniker.ts`) is derived from `className.name(signature)`, not the path id, so two nested
   twins still share a `stableId` — the SAME documented "homonym" completeness limit
   (`scip/stable-id.test.ts`), resolved only when unique. Qualifying `stableId` by enclosing scope is a
   later refinement; it is not required for the node-distinctness / correct-edge guarantees here.

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
- **`export function` / decorated double-match → one node.** The wrapper and its inner declaration
  share an id and MUST stay collapsed; the same-id-container guard ensures the inner one is never
  re-keyed as nested. (Verified: `export async function createOrder` stays a single node.)
- **Identity stable across edits.** A nested function MUST NOT appear as removed+added in
  `structural_diff` / `change_impact_certificate` when unrelated code shifts. (This is why the
  discriminator must be scope-based, not positional. Verified by a stability test.)
- **No regression in the six identity-bearing subsystems:** `structural-diff`, `impact-certificate`,
  `stable-id`, `scip-export`, `cross-service-topology`, anchoring (`decisions/anchor-*`) — all green.

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
