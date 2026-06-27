# Dogfood — change footprint projection (2026-06-24)

Ran the shipped `computeFootprint` / `classifyHazard` against **this repository's real persisted call
graph** (`.openlore/analysis/llm-context.json`: **5932 nodes, 14825 edges**) to confirm the primitive
behaves on real data and reproduces the hand-computed validation exercise from
`PARALLEL-WORK-COORDINATION.md`.

## Setup

The four PARALLEL-WORK proposals, treated as tasks, seeded with their real hot-spots:

| Task | Seed | writeMode |
|------|------|-----------|
| `T2-planner` (`plan_parallel_work`) | `dispatchTool` | `append` |
| `T3-escape` (escape detection) | `handleStructuralDiff` | `modify` |
| `T4-crossactor` (cross-actor map) | `dispatchTool` | `append` |

## Results

```
Ambient fan-in threshold (p99): 7   — symbols with fan-in > 7 excluded from read-sets

[T2-planner]     write=1 read=288 affected=6 ambientExcl=13 unresolved=[]
[T3-escape]      write=1 read=30  affected=7 ambientExcl=6  unresolved=[]
[T4-crossactor]  write=1 read=288 affected=6 ambientExcl=13 unresolved=[]

  T2-planner × T3-escape     → RAW (A after B)  witness=handleStructuralDiff
  T2-planner × T4-crossactor → shared-append    witness=dispatchTool
  T3-escape  × T4-crossactor → RAW (B after A)  witness=handleStructuralDiff

Determinism on real graph: PASS (byte-identical)
Unresolved seed → write=0, note=["thisSymbolDoesNotExist_xyz"]
```

## What this confirms

1. **The `shared-append` refinement works on the real hot-spot.** `T2-planner × T4-crossactor` both
   append the 62-branch `dispatchTool` dispatcher and classify **`shared-append`**, NOT `WAW` — the
   exact false-conflict collapse the validation exercise predicted, now demonstrably avoided. Without
   `writeMode: append` these two tasks would have been forced into different waves.

2. **Ambient exclusion is load-bearing and bounded.** The p99 fan-in threshold on the real graph is
   **7**; 13 ubiquitous hubs were excluded from `T2`'s read-set (288 → kept, hubs dropped), preventing
   the read-set from bloating toward the whole graph through `logger` / `validateDirectory` / the
   call-graph primitives.

3. **RAW ordering is directed and correct.** `T2-planner` reads `handleStructuralDiff` (in its forward
   closure) which `T3-escape` writes, yielding `RAW (A after B)` — T2 must run after T3. The reverse
   pair reports the symmetric direction.

4. **Determinism + honesty hold on real data.** Re-evaluation is byte-identical; an unknown seed yields
   an empty footprint with an explicit `unresolvedSeeds` note, never a fabricated region.

## Honest caveat

A fifth task seeded on the brand-new `change-footprint.ts` file resolved as **unresolved** (empty
footprint) because that file was created in this session and is not yet in the pre-existing index. This
is the intended fail-soft behavior (no fabricated region for an unindexed seed), not a defect — a fresh
`openlore analyze` would index it. The proposal's predicted `[T1] → [T2,T3,T4]` RAW backbone therefore
only materializes after a re-index, which is expected.
