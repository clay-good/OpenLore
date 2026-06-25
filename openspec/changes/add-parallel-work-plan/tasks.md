# Tasks — Parallel work plan

> Status: SHIPPED (2026-06-24) on branch `feat/parallel-work-plan` (stacked on PR #199).
> Tool: `plan_parallel_work` → `src/core/services/mcp-handlers/plan-parallel-work.ts` (+ test).
> Opt-in `coordination` preset only.

## 1. Tool contract & registration
- [x] Add `plan_parallel_work` handler (input: `directory`, `tasks: TaskDescriptor[]`).
- [x] Classify `conclusion` in `tool-contract.ts`; `tool-contract.test.ts` passes (output uses
      `taskA`/`taskB` pair fields, never `from`/`to`/`callerId`, so it is never an id-reference edge dump).
- [x] Register in a new opt-in `coordination` preset (orient + plan_parallel_work + analyze_impact +
      find_path). NOT in `MINIMAL_TOOLS` / lean default. Updated preset wiring + the tool-count guard
      (62→63) + the spec-28 full-surface byte budget (64k→66k, documented) + the spec-09 harness driver.

## 2. Compose footprints + conflict graph (proposal 1)
- [x] Compute each task's footprint via the proposal-1 projection (`computeFootprint`).
- [x] Build the pairwise conflict graph: every pair runs `classifyHazard`; keep verdict + witnesses +
      RAW direction.

## 3. Schedule
- [x] Waves: greedy assignment in RAW-topological order; each task takes the smallest wave strictly
      after its RAW predecessors and not occupied by a WAW-conflicting peer (shared-append / WAR / soft
      do NOT split a wave). Wave 1 = dispatch-now set; later waves name awaited predecessors (`waitsOn`).
- [x] Critical path: longest hard-ordered chain (RAW edges + WAW directed by wave) → minimum sequential
      rounds; emits the "≤ K rounds / beyond M agents buys nothing" read.
- [x] Advisories: shared-append, soft-coupling, and WAR/low-risk pairs collected as non-serializing
      warnings with notes.

## 4. Statelessness & honesty
- [x] No cross-call state, no lease, no assignment. Pure `render(state)`; re-invoke with remaining
      tasks to re-plan (byte-identical determinism test on real + fixture data).
- [x] Standing disclosure attached: footprints are predicted/advisory; integration tests are ground
      truth; no guarantee of conflict-free parallelism.

## 5. Gating (opt-in only)
- [x] WAW conflicts surface as the `parallel-work-conflict` governance finding through
      `enforcement.policy`; default advisory (`resolveEnforcementClass(... , undefined) === 'advisory'`),
      blocking only if an operator opts in. Code registered in `FINDING_CODE_REGISTRY`.

## 5b. Post-review hardening (adversarial e2e pass, 2026-06-24)
- [x] **Unorderable RAW cycles** (≥3 one-directional RAW edges, reachable under bounded read-distance):
      detected via Tarjan SCC over the RAW graph, DISCLOSED as a `parallel-work-cycle` finding, and the
      members placed in mutually exclusive waves — never a silently-broken, confidently-wrong schedule
      (the prior code assumed cycles couldn't survive the bidirectional downgrade; they can). Fixes the
      one HIGH soundness finding from the adversarial review. Also keeps `criticalPath.rounds` ==
      `chain.length` with no repeated node.
- [x] **Coupling store hardened**: an older index lacking the `change_coupling` table made
      `getChangeCouplingForFiles` throw; the lookup is wrapped so a missing/broken store degrades to
      "no coupling", never a crash.
- [x] **Task-count cap** (`MAX_TASKS = 64`): over the cap is an explicit error (no silent truncation),
      bounding the O(N²) conflict graph + O(N·E) footprint cost and the payload.

## 5c. Output-size hardening (second adversarial e2e pass via real `dispatchTool`, 2026-06-24)
- [x] **Response byte-bounding**: the worst-case real-dispatch response was ~1 MB (64 dense-conflict
      tasks) and up to ~770 KB (whole-file seeds), which the dispatch-level 256 KB structured-result cap
      would mangle into an unparseable string. Now every O(N²) list (`conflicts` / `advisories` /
      `findings`) and every per-task footprint region is capped with an authoritative uncapped count +
      truncation flag, witnesses are capped (`WITNESS_CAP`), and a deterministic byte-budget backstop
      (`SOFT_BUDGET_BYTES`) collapses footprint sample lists (then trims evidence) with a
      `truncationNote` for extreme plans. Verified via real `dispatchTool` round-trips: worst case now
      ~193 KB, whole-file case 770 KB → 98 KB; the schedule + counts always survive.
- [x] **Enforce-seam honesty**: clarified across the tool docstring, `docs/mcp-tools.md`, `CLAUDE.md`,
      and `docs/configuration.md` that the `parallel-work-*` findings are policy-*shaped* for the
      **caller** to gate on (`resolveEnforcementClass`); the bundled `openlore enforce` commit gate is
      diff-based, never runs the planner, and never blocks on them.

## 6. Tests
- [x] 3 disjoint tasks → 1 wave.
- [x] WAW pair (≥1 `modify`) → separate waves + advisory finding.
- [x] shared-append pair → same wave + advisory, no finding.
- [x] RAW chain → ordered waves + critical path length + `waitsOn`.
- [x] Same-file disjoint symbols → 1 wave + WAR advisory.
- [x] Soft-coupling pair → advisory, not serialized.
- [x] Re-invoke subset → deterministic re-plan.
- [x] `conclusion` classification + coordination-preset membership (and absence from lean/minimal/memory)
      guarded by tests.
- [x] Worked-example regression: the 4-proposal set with `append` registry seeds → 2 waves; the naive
      `modify` default → 4 waves (guards the hot-spot collapse from returning).

## 7. Verify & dogfood
- [x] `npm run lint`, `npm run typecheck`, `npm run test:run` (246 files, 4904 pass / 2 skip),
      `npm run build` — all green.
- [x] Dogfood: ran `plan_parallel_work` against this repo's real index with 4 real-symbol tasks;
      reproduced shared-append on `dispatchTool`, RAW-ordered the readers after the writers, byte-identical
      determinism. See `DOGFOOD-parallel-work-plan.md`.

## 8. Docs
- [x] Documented the tool in `docs/mcp-tools.md` (coordination-preset section): input descriptors, the
      wave/critical-path output, the stateless re-plan pattern, advisory-by-default + opt-in gating, the
      opt-in preset, and the ground-truth disclosure. Module doc-comments cross-link the footprint
      primitive (proposal 1) and note escape detection (proposal 3) as the back-side check.
