# Tasks — iterative dependency-cycle detection

> Status: **BUILT** (2026-08-01). Typecheck clean, lint clean, build green.

## How this was found (the reproducer IS the acceptance criterion)
- [x] Stress-tested #302's memory fixes on a synthetic repo LARGER than microsoft/TypeScript (126k
      functions) — completed at 809 MB peak heap, confirming the memory multiplication is gone
- [x] A generated repo with an 8,000-file **linear import chain** crashed `analyze` with
      `RangeError: Maximum call stack size exceeded` in `dependency-graph.ts` `detectCycles` — a
      fatal crash, distinct from #302's heap OOM (stack, not heap; Phase 2, not enrichment)
- [x] Confirmed the sibling walks were already safe: `tarjanScc`/betweenness are iterative; per-file
      AST walkers (style, CFG) are exception-isolated (a 40,000-deep nested file analyzes to
      completion by degrading the one file)

## The fix
- [x] Extract cycle detection into a pure, exported, **iterative** `detectDependencyCycles`
      (explicit frame stack); `detectCycles` is now a thin wrapper. Deleted the recursive `dfs` and
      the `isDuplicateCycle`/`normalizeCycle` private methods (used only here)
- [x] Each frame tracks its neighbor index, so enter/leave order — and therefore cycle output — is
      identical to the recursion
- [x] Dedup by rotation-invariant key in a `Set` (was an O(cycles²) pairwise scan): same result,
      no second quadratic on a graph with many cycles

## Verification
- [x] **Equivalence**: new implementation vs. a verbatim copy of the old recursion over 200 random
      seeded graphs + hand cases (direct, indirect, self-loop, disjoint, overlapping) — all
      deep-equal
- [x] **No crash**: a 50,000-deep chain (acyclic → no cycle; closed → exactly one cycle of length
      n+1) completes without throwing
- [x] **Non-vacuous guard**: the same 50,000-deep input is asserted to throw `RangeError` from the
      recursive oracle, so the no-crash test is proven to exercise real stack depth
- [x] Existing `dependency-graph.test.ts` circular-dependency cases pass unchanged
- [x] End-to-end: the 8,000-file-chain repro that threw now completes (exit 0)
- [x] Full suite, typecheck, lint, build
