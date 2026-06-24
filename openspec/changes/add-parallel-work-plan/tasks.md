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
