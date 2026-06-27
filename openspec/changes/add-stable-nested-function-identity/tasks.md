# Tasks — stable identity for nested functions

## 1. Identity scheme
- [ ] Define the qualified nested id: enclosing function/method id segment + `/` + nested name
      (`file::A.m1/helper`); secondary document-order ordinal for same-scope twins (`…/helper#2`).
- [ ] Confirm the qualifier is STABLE across edits (derive from the enclosing node's own id, never a
      byte offset). Write the stability argument in the change’s notes.

## 2. Builder
- [ ] Shared helper that re-keys only byte-CONTAINED nested function nodes (a node strictly inside
      another function node), leaving sibling collisions collapsed.
- [ ] Call the helper in every extractor (TS/JS, Python, Go, Rust, Ruby, Java, C++, Swift, the generic
      `extractByQueries`, Dart, Elixir) AND in the shared `dedupeOverlappingCalls` — after node
      extraction, BEFORE call extraction — so `rawEdge.callerId` carries the unique id. (The PR #213
      `ensureUniqueNodeIds` scaffold did this; reuse the placement, replace the discriminator.)
- [ ] Keep the CFG map and any per-node side-tables keyed by the FINAL id (avoid the CFG-mismatch the
      positional attempt left for re-keyed nodes).

## 3. Stable-id integration
- [ ] Derive `stableId` from the qualified nested identity so scip export / structural-diff / impact
      certificate / anchoring see a stable symbol; verify round-trip across body edit + file move.

## 4. Scope contract (regression guards)
- [ ] `call-graph.test.ts` "collapses a re-assigned member … no duplicate explosion" stays green.
- [ ] `scip/stable-id.test.ts` "same-file container-name collapse … completeness limit" stays green.
- [ ] No nested function reads as removed+added in `structural-diff` / `impact-certificate` on an
      unrelated edit (add an explicit stability test).
- [ ] Full suite green across the six identity-bearing subsystems: structural-diff, impact-certificate,
      stable-id, scip-export, cross-service-topology, anchoring.

## 5. Tests
- [ ] Distinct nodes + correct per-nested-function edge attribution (the target case).
- [ ] Stability-across-edit test (id + stableId unchanged when unrelated code shifts).
- [ ] Same-scope twin ordinal test.
- [ ] Per-language spot checks where nested functions are idiomatic (TS/JS, Python at least).

## 6. Verify
- [ ] `npm run build`; `vitest run src examples` green.
- [ ] Dogfood on the OpenLore repo: confirm previously-merged nested functions now appear as distinct
      nodes with correct fan-in/out, and that the self_cls / structural-diff numbers do not churn for
      unrelated code.
