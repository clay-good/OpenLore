# Tasks — Working-set context briefing

> Status: IMPLEMENTED (2026-06-21) — shipped on branch `feat/working-set-context-briefing`. Decision
> `e7c73f5d`. Second of three in `SPEC-STORE-INTEGRATION.md`. Builds on `add-spec-store-binding`,
> `orient`, `add-trust-calibrated-context-economy`. See "Implementation status" at the foot of this file.

## 1. Working-set assembly across targets
- [x] Given a bound store and an active change (intent text + declared touched areas / spec deltas if
      present), run task-scoped orientation against each resolved target in the binding's federation set
      and merge into one briefing.
      → new handler `src/core/services/mcp-handlers/working-set.ts`, reusing `handleOrient` +
      `handleSpecStoreStatus` (the single source of truth for which targets are briefable).
- [x] Each briefing item carries its target repository ID and symbol ID (per-target attribution).
      → `briefTargetFromOrient()` attributes every item to its target name.
- [x] Test: a change targeting two repos returns a single briefing with items attributed to each target.
      → `working-set.test.ts` (pure `briefTargetFromOrient` + `rankAndBudget` cover deterministic
      multi-target merge; the real-index integration is exercised in the dogfood report).

## 2. Budget + anchored intent
- [x] Apply the trust-calibrated context budget across the merged briefing; rank by structural relevance
      to the change scope; emit an explicit omission note when truncated.
      → `rankAndBudget()` reuses `applyTokenBudget` / `omissionNote`. The global budget is the SINGLE
      truncation point — orient runs per target at full fidelity so anchored intent is never starved.
- [x] Fold in fresh, in-scope anchored decisions/constraints with their verdicts; withhold orphaned
      intent; flag drifted intent.
      → reuse orient's `governingDecisions` (verdict `current`) + `staleDecisions` (verdict `drifted`);
      orphaned anchors are withheld by orient upstream, so they never appear as current.
- [x] Test: an over-budget working set is truncated with an omission note; orphaned intent is withheld.
      → `working-set.test.ts` (`rankAndBudget` truncation + omitted count; `briefTargetFromOrient`
      withholds current intent when no governing decisions exist).

## 3. Surfaces + machine contract
- [x] MCP tool `working_set_context` classified `conclusion` in `tool-contract.ts`; registered in
      `tool-dispatch.ts`, `TOOL_DEFINITIONS` (mcp.ts), `tool-driver.ts`. Added to the opt-in `federation`
      preset; kept OUT of `minimal`/`navigation`/`memory`. Full surface 61 → 62 (payload ceiling 62k → 63k).
- [x] CLI `openlore working-set context [--change <id>] [--json] [--token-budget <n>]`.
      → `src/cli/commands/working-set.ts`, registered in `src/cli/index.ts`; read-only, exits 0.
- [x] Test: output is conclusion-shaped (`assertConclusionShape`); `--json` shape is documented and
      stable; contract/driver/preset cross-checks pass.
      → `working-set.test.ts` + the `working-set` CLI test + the `tool-contract`/`tool-driver`/`mcp-presets`
      gates (which fail until the tool is classified/registered) all pass.

## 4. Docs
- [x] Document the working-set briefing, its per-target attribution, and its budget/omission behavior in
      the `mcp-handlers` and `cli` specs, `docs/mcp-tools.md`, `docs/cli-reference.md`, and the CLAUDE.md
      tool table. Bumped the count-guarded docs 61 → 62 and the `--preset` help string. Recorded the
      dogfood run in `DOGFOOD-working-set-context.md`. Tracked spec files need `git add -f`.

## Implementation status

**IMPLEMENTED (2026-06-21).** All tasks complete on branch `feat/working-set-context-briefing`.

- **Handler** `src/core/services/mcp-handlers/working-set.ts` — `handleWorkingSetContext(directory,
  change?, tokenBudget?, limit?)`. Composes `handleSpecStoreStatus` (binding health → briefable targets)
  + `handleOrient` per target. Pure, exported, unit-tested cores: `extractIntent`,
  `briefTargetFromOrient`, `rankAndBudget`. Never throws — every problem is a finding.
- **CLI** `src/cli/commands/working-set.ts` — `openlore working-set context`; read-only, exits 0.
- **Surface** tool 61 → 62; `working_set_context` in the opt-in `federation` preset only; payload
  ceiling 62k → 63k.
- **Tests** `working-set.test.ts` (15) + `working-set` CLI test (2) + the contract/driver/preset gates.
- **Dogfood** `DOGFOOD-working-set-context.md` — real-index e2e against the OpenLore repo as a target:
  oriented the change's intent, surfaced `handleWorkingSetContext`/`readChange`/`SpecStoreConfig` with
  callers attributed to the target, 2 `current` anchored-intent items, and a verified budget/omission.
- **Out of scope (next change):** certifying impact (blast radius, newly-opened paths, drift) is
  `add-change-impact-certificate`.
