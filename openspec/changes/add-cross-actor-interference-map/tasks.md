# Tasks — Cross-actor interference map

> Status: SHIPPED (2026-06-24). Surface: new sibling conclusion tool `map_in_flight_conflicts`
> in the `federation` + `coordination` presets. Core: `src/core/services/mcp-handlers/interference-map.ts`;
> tests: `interference-map.test.ts`. Dogfooded on this repo's real branches AND open PRs (#199/#200/#201) —
> correctly flagged PR #200 × #201 WAW on `dispatchTool`, and honestly marked PR #199 "not assessed"
> (its diff is all new files → no base symbols).

## 1. In-flight change enumeration
- [x] Local branches: diff against the merge-base → changed files + hunks (git `--unified=0`). Reuses
      existing git access (`defaultEnumerateBranches`).
- [x] Open PRs (when `gh` is available): changed files via `gh pr diff --patch`. Unfetchable PR →
      "not assessed" node (`diff-unfetchable`). Absent `gh` → PRs skipped with a caveat, never a false
      "no conflict".
- [x] Actor-attributed nodes `{ actor, ref, repo, kind }`; agent task descriptors (proposal 2) join as
      first-class `agent-task` nodes via `computeFootprint`.

## 2. Footprints from diffs (proposal 1)
- [x] Per change, the write-set is derived from the ACTUAL diff: each hunk is mapped to the enclosing
      symbol of the BASE snapshot (re-parsed per changed file, like `structural_diff`/`impact_certificate`),
      with a per-symbol `writeMode` read off the hunks (`append` iff pure-insertion, else `modify`). Read /
      affected / coupling regions come from the proposal-1 projection (`footprintForChange`).

## 3. Cross-actor / cross-repo conflict graph
- [x] Pairwise `classifyHazard` (proposal 1) across all assessed nodes.
- [x] Federation: each resolvable target repo (via `spec_store_status`) is enumerated in its own index;
      cross-repo pairs match by content-addressed **stable id** (`projectToStableIds`). No federation →
      single-repo. Stale/missing target index → its changes "not assessed".
- [x] Output per conflict: the two actors, hazard class, witnessing symbols (federated symbols NAMED, not
      stable-id hashes), `crossRepo` flag, and a suggested landing order.

## 4. Surface (decided at implementation)
- [x] `map_in_flight_conflicts` (sibling conclusion tool) — keeps `plan_parallel_work`'s
      caller-supplied-descriptor contract intact.
- [x] Classified `conclusion` (`tool-contract.ts`); lands in the `federation` + `coordination` presets
      (not lean default). Tool-count guard + payload-budget guard updated (63→64; budget 66k→68k).

## 5. Statelessness, honesty, gating
- [x] On-demand only — no watcher/poll/background process; no persisted conflict store; pure `render(state)`.
- [x] "Not assessed" reasons: `diff-unfetchable` / `no-resolvable-symbols` / `index-stale` / `index-missing`
      — never a false "no conflict".
- [x] Advisory by default; WAW → policy-shaped `cross-actor-conflict` finding (registered in
      `FINDING_CODE_REGISTRY`) a CI check can gate on via `resolveEnforcementClass`. Standing ground-truth
      disclosure attached to every result.

## 6. Tests & fixtures
- [x] Two local branches sharing a written symbol → WAW between actors.
- [x] Agent task descriptor + branch sharing a symbol → cross-actor WAW.
- [x] Two PRs appending disjoint entries to the same registry → `shared-append`, no WAW.
- [x] Federated fixture: branch in repo A + PR in repo B sharing a stable id → cross-repo WAW.
- [x] Unfetchable PR → "not assessed"; unresolved-symbols change → "not assessed"; stale target → "not assessed".
- [x] No federation → clean single-repo degrade. Determinism for fixed input. Conclusion-shape contract.

## 7. Verify & dogfood
- [x] `npm run lint`, `npm run typecheck`, `npm run test:run` (243 files / 4899 tests), `npm run build` green.
- [x] Dogfood: ran against this repo's own open branches AND PRs; confirmed a real overlap is surfaced
      (PR #200 × #201 both modify `dispatchTool`).

## 8. Docs
- [x] `CLAUDE.md` tool table row; `docs/mcp-tools.md` table entry + prose; preset help strings; tool-count
      surfaces (README/docs/cli spec) bumped 63→64. Dogfood note in `DOGFOOD-cross-actor-interference-map.md`.
