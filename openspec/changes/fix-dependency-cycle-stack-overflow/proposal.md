# Cycle detection must not abort analyze on a deep dependency chain

> Status: **BUILT** (2026-08-01). Found while stress-testing whether issue #302's memory fixes hold
> at scale: a repository with a long import chain crashes `analyze` for a different reason — the
> stack, not the heap. Deterministic, no LLM, no new dependency, output byte-identical.

## The gap

After issue #302's memory fixes, `openlore analyze` still has a fatal-crash class on a large
repository — but it is a **stack** overflow, not a heap OOM, and it happens in an earlier phase.

`DependencyGraphBuilder.detectCycles` walked the module dependency graph with a **recursive** DFS.
Recursion depth equals the dependency-chain length, so a repository with a chain of a few thousand
files (a deeply layered architecture, a long barrel-re-export chain, generated code) overflows the
JS call stack:

```
RangeError: Maximum call stack size exceeded
    at dfs (dependency-graph.js:456)
    at dfs (dependency-graph.js:456)
    ... (thousands of frames)
```

This runs in Phase 2 of every `analyze`/`install`, is not inside any per-file exception boundary,
and so aborts the analysis of the whole repository. Reproduced end to end: a generated repo with an
8,000-file linear import chain threw this and exited non-zero; the same repo now completes.

Why the sibling AST walkers (style, CFG) do **not** crash on a deeply nested file: those run
per-file inside a `try/catch` that degrades the one file and proceeds. Whole-graph walks like this
one have no such boundary, so their overflow is terminal. The call-graph SCC (`condensation.ts`
`tarjanScc`) and the betweenness BFS were already iterative for exactly this reason; this walk was
the one that was missed.

## What changes

`detectCycles` now delegates to a module-level, **iterative** `detectDependencyCycles` with an
explicit frame stack. Each frame remembers its position in its neighbor list, so nodes are entered
and left in the identical order, back-edges are found at the identical points, and the identical
cycles are recorded in the identical order. Deduplication moves from an O(cycles²) pairwise scan to
a rotation-invariant key in a `Set` — same result, without a second latent blowup on a graph with
many cycles.

## Why it is safe

- **Output-identical.** An equivalence test runs the new implementation against a verbatim copy of
  the old recursion over 200 random graphs plus hand cases (direct, indirect, self-loop, disjoint,
  overlapping cycles); every result is deep-equal.
- **The crash is really fixed.** A 50,000-deep chain (acyclic, and closed into one cycle) completes
  without throwing; the same input is asserted to overflow the recursive oracle, so the guard is
  not vacuous.
- The existing `dependency-graph.test.ts` circular-dependency cases pass unchanged.

## Deliberately NOT in scope

The per-file AST walkers (style, CFG, Elixir) are already crash-safe via per-file exception
isolation — a deeply nested file degrades to a disclosed parse-failure rather than aborting the
build (verified: a 40,000-deep nested file analyzes to completion). Converting those to iterative
would be defense-in-depth with real equivalence risk and no crash to fix, so it is left out.
