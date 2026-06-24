# Dogfood — plan_parallel_work (2026-06-24)

Drove the shipped `computePlanParallelWork` handler against **this repository's real index** (via the
normal `readCachedContext` path — real call graph + edge store), with four tasks seeded on real symbols,
to confirm the tool produces a sensible schedule end-to-end.

## Tasks

| Task | Seed | writeMode |
|------|------|-----------|
| `T2-planner` | `dispatchTool` | `append` |
| `T3-escape` | `handleStructuralDiff` | `modify` |
| `T4-crossactor` | `dispatchTool` | `append` |
| `T5-blast` | `handleBlastRadius` | `modify` |

## Output

```
Conflicts:
  T2-planner    × T3-escape     → RAW (A after B)  witness=handleStructuralDiff
  T2-planner    × T4-crossactor → shared-append    witness=dispatchTool
  T2-planner    × T5-blast      → RAW (A after B)  witness=handleBlastRadius
  T3-escape     × T4-crossactor → RAW (B after A)  witness=handleStructuralDiff
  T3-escape     × T5-blast      → WAR              witness=…sample.ts::Repository.add
  T4-crossactor × T5-blast      → RAW (A after B)  witness=handleBlastRadius

Waves:
  wave 1: [T3-escape, T5-blast]      waitsOn=[]
  wave 2: [T2-planner, T4-crossactor] waitsOn=[T3-escape, T5-blast]

Critical path: 2 round(s) — chain [T3-escape → T2-planner]
  At most 2 sequential round(s) even with unlimited agents; peak wave width is 2,
  so beyond 2 concurrent agent(s) buys nothing.

Advisories:
  shared-append: T2-planner × T4-crossactor (dispatchTool)
  WAR:           T3-escape  × T5-blast       (Repository.add)

Determinism: PASS (byte-identical)
```

## What this confirms

1. **The registration hot-spot does not serialize.** `T2-planner` and `T4-crossactor` both append
   `dispatchTool`; the pair classifies **`shared-append`** and the two tasks ride together in wave 2 —
   exactly the false-conflict collapse the `shared-append` class exists to prevent.

2. **Read-after-write orders the schedule correctly.** `T2`/`T4` read `handleStructuralDiff` and
   `handleBlastRadius` (in their forward closures), which `T3`/`T5` write — so the readers are RAW-ordered
   into wave 2, behind the writers in wave 1. The `waitsOn` field names exactly the predecessors.

3. **Same-file-disjoint stays parallel.** `T3` and `T5` touch disjoint symbols that share a `WAR`
   low-risk overlap; they remain together in wave 1 rather than being split.

4. **The critical path is honest.** 2 rounds, peak width 2 — beyond 2 agents buys nothing on this set.

5. **Deterministic.** Re-invoking with the same tasks yields a byte-identical plan (the stateless
   `render(state)` contract).

No `parallel-work-conflict` findings fired here because none of these four tasks have a true write-write
(WAW) overlap; the WAW → finding path is covered by the unit tests (a pair both seeding the same symbol
in `modify` mode).
