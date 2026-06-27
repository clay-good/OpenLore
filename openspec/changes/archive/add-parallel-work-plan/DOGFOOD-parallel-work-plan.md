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

## Adversarial hardening pass (2026-06-24)

A second, adversarial review (parallel agents + real-input probes) surfaced one HIGH soundness gap and
two robustness gaps, all now fixed and regression-tested:

1. **Unorderable RAW cycle, silently broken (HIGH → fixed).** A cycle of one-directional RAW edges
   (`A→B→C→A`) survives the bidirectional-only downgrade and *is reachable* under bounded read-distance —
   confirmed by constructing it against the real footprint code (`readMaxDistance: 1`, a 3-node
   call-graph cycle yields exactly `B after A`, `C after B`, `A after C`). The old scheduler broke it
   silently into a clean-looking 3-wave plan in which a task ran before a dependency. Now Tarjan SCC
   detects the cycle, the plan emits a `parallel-work-cycle` finding disclosing the members, and they are
   placed in mutually exclusive waves — honest, not confidently wrong.

2. **Coupling-store crash (fixed).** An older index without the `change_coupling` table made the coupling
   lookup throw; it is now wrapped to degrade to "no coupling".

3. **Unbounded task list (fixed).** A `MAX_TASKS = 64` cap returns an explicit error instead of producing
   an O(N²) payload silently.

Re-dogfooded after the fixes on the real index: the mixed-hazard plan is unchanged (2 waves), the cap
fires at 65 tasks, an all-unresolved task degrades to one wave with its `unresolvedSeeds` reported, and
the plan stays byte-identical across re-invocations.

## Second adversarial pass — output size via real `dispatchTool` (2026-06-24)

Exercising the **real MCP entry point** (`dispatchTool('plan_parallel_work', …)`, not just
`computePlanParallelWork`) surfaced a severe response-size bug the first pass missed:

| Adversarial plan (64 tasks, real index) | Before | After |
|------------------------------------------|--------|-------|
| all-WAW on `dispatchTool` | ~1,012 KB | 193 KB |
| each seeded on a god-function (`handleOrient`) | ~1,028 KB | 192 KB |
| each seeding a whole large file | ~770 KB | 98 KB |
| 12 realistic tasks | — | 50 KB |

A response over the dispatch-level **256 KB cap** (`MCP_TOOL_MAX_BYTES`) does not degrade gracefully —
`capStructuredResult` falls back to wrapping the whole structured result in an unparseable `{ truncated,
partial: "<sliced JSON>" }` string, i.e. the agent receives garbage. The fix bounds the response
semantically *before* it returns: the O(N²) `conflicts` / `advisories` / `findings` lists and every
per-task footprint region carry a cap + an authoritative uncapped count, witnesses are capped, and a
deterministic byte-budget backstop collapses footprint sample lists (then trims evidence) with a
`truncationNote` for extreme plans. The schedule (waves + critical path) and all counts are always
complete. Malformed args through the real dispatch path (`tasks` missing / a string / an item with no
`id`) return clean error strings.

The same pass corrected an honesty gap in the docs: the `parallel-work-*` findings are *policy-shaped*
for the **caller** to gate on; the bundled `openlore enforce` commit gate is diff-based and never runs
the planner, so it never blocks on them.
