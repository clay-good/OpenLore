# Tasks — stable identity for nested functions

## 1. Identity scheme
- [x] Qualified nested id = enclosing function/method id segment + `/` + nested name
      (`file::A.m1/helper`); document-order ordinal for same-scope twins (`…/helper#2`).
- [x] Qualifier is STABLE across edits (derived from the enclosing node's own id, never a byte offset).

## 2. Builder
- [x] Shared helper `ensureUniqueNodeIds` re-keys only byte-CONTAINED nested function nodes whose
      container has a DIFFERENT id (a same-id container is the same function matched twice — export
      wrapper / decorator — and stays collapsed). Sibling collisions stay collapsed.
- [x] Called in every extractor (TS/JS, Python, Go, Rust, Ruby+Java via the shared
      `dedupeOverlappingCalls`, C++, Swift, generic `extractByQueries`, Dart, Elixir) AFTER node
      extraction, BEFORE call extraction — so `rawEdge.callerId` carries the unique id.
- [x] Outermost→innermost processing so an enclosing function's id is final before a child qualifies.

## 3. Stable-id scope
- [x] PATH id is now unique + stable for nested functions (the structural fix). `stableId` continues to
      derive from `className.name(signature)`; nested twins share a `stableId` (existing homonym
      completeness limit). Scope-qualified `stableId` is a deferred refinement, NOT required here.

## 4. Scope contract (regression guards) — all green
- [x] `call-graph.test.ts` "collapses a re-assigned member … no duplicate explosion" stays green.
- [x] `scip/stable-id.test.ts` "same-file container-name collapse … completeness limit" stays green.
- [x] `export async function` double-match stays one node (new guard + test).
- [x] No nested function reads as removed+added on an unrelated edit (new stability test).
- [x] Full suite green across structural-diff, impact-certificate, stable-id, scip-export,
      cross-service-topology, anchoring.

## 5. Tests
- [x] Distinct nodes + correct per-nested-function edge attribution (target case).
- [x] Stability-across-edit test (path id unchanged when unrelated code shifts).
- [x] Same-scope twin ordinal test.
- [x] Export-wrapper scope-contract test.

## 6. Verify
- [x] `npm run build`; `vitest run src examples` green (271 files / 5320+ tests).
- [x] Dogfood on the OpenLore repo: genuine nested collisions now distinct (e.g. two `cleanup` arrows
      in `startMcpServer`, two `getDiff` arrows in `extractFromDiff`); a handful repo-wide, no churn
      elsewhere.
