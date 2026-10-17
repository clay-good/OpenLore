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

## Folded in after multi-agent review

A parallel audit of the whole codebase (every recursive walk classified) and of the adjacent
dependency-graph algorithms surfaced two more issues in the same "any repo size/shape" spirit, both
fixed here, both output-preserving:

- **Style-fingerprint walk was a silent determinism hole (not a crash).** The per-file style walk
  recursed over the parsed tree and overflowed on a deeply-nested file — but the throw was swallowed
  by `tallyStyle`'s blanket `catch`, so the file's whole style contribution vanished *silently*, and
  because the stack limit is environment-dependent, it vanished on some machines and not others.
  That breaks the byte-identical-artifact guarantee. Converted to an iterative pre-order walk
  (children pushed in reverse → identical visitation and counters); the deep file now keeps its
  style deterministically. Verified: a 30,000-deep file's style is present and its shallow idioms
  are still tallied.
- **Two superlinear factors made large-graph analyze crawl.** The dependency graph runs on up to
  100,000 nodes with no size guard. Brandes betweenness drained its BFS with `Array.prototype.shift`
  (O(n) dequeue) and re-initialized four V-sized maps per source (O(V²)); `detectClusters` rescanned
  every edge for every directory group (O(D·E)). Both are now near-linear (head-index queue +
  touched-node reset; one O(E) edge pass), output byte-identical (normalized centrality maxAbsDiff 0,
  cluster stats unchanged) — ~29× and ~19–49× faster on large graphs.

## Deliberately NOT in scope

The remaining per-file AST walkers (CFG, Elixir) and the IaC object walkers are already crash-safe
via per-file / whole-corpus exception isolation — a deeply nested file degrades rather than aborting
the build (verified: a 40,000-deep nested file analyzes to completion, keeping its functions, edges,
and CFG). An AST max-depth *exclusion* was considered and rejected: it would discard data that is
extracted successfully today, and a robust depth probe costs 85%+ of parse time on every normal
file. Converting those walkers to iterative is defense-in-depth with real equivalence risk and no
crash or determinism bug to fix, so it is left out.
