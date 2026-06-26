# Tasks — Change significance briefing

> SHIPPED 2026-06-26. Pure module `src/core/analyzer/change-significance.ts`, handler
> `src/core/services/mcp-handlers/briefing-since.ts`, MCP tool `briefing_since` (full preset), CLI
> `openlore briefing-since`. Tests (26): `change-significance.test.ts` (8) + `briefing-since.test.ts`
> (8, handler) + `briefing-since.test.ts` (5, CLI) + `git-diff.test.ts refExists` (4) + preset guard (1).
> Review-hardened 2026-06-26 (adversarial e2e + spec audit): silent base-ref fallback now disclosed
> (`baseRefFallback` + lead caveat, new `refExists` helper); file-path-exact churn join (git doesn't
> follow renames) caveated when surprise is live; full-surface-only preset guard + CLI test added.

## 1. Significance labeling
- [x] Compute changed symbols between a base ref and the current state. (File-level granularity via
      `getChangedFiles` + `seedsFromFiles`, the same primitive `select_tests`/`report_coverage_gaps`
      use; disclosed in a caveat.)
- [x] Label via existing classifiers only: `surprising-change` (hub via `landmark-signals` + low churn
      via `volatilityLevel`) > `hub-change` > `chokepoint-change` > `ordinary-change`; order within
      a tier by raw fan-in. No composite score, no new constant.
      **Partition note:** because OpenLore defines `chokepoint = hub ∧ ¬orchestrator`, every chokepoint
      is also a hub. To keep `chokepoint-change` a non-empty tier, the non-surprising hubs split on the
      existing `orchestrator` label — a broad god-hub → `hub-change`, a pure funnel → `chokepoint-change`.
- [x] Attach raw evidence (fan-in, fan-out, prior churn, volatility level) to each labeled symbol.
- [x] Withhold `surprising-change` when churn history is too shallow (`< 2` non-bulk commits scanned →
      fall back to `hub-change`/`chokepoint-change`); availability + reason disclosed in the output.

## 2. Briefing assembly
- [x] Group changes by region/community (`communityLabel`); include tests-to-run via `handleSelectTests`.
- [x] Bound the briefing size, highest-tier-first; emit a truncation receipt (omitted count + per-tier
      breakdown + lowest tier reached). Never drop a higher tier for a lower one (guaranteed by the sort).

## 3. MCP + CLI surface
- [x] Opt-in `briefing_since` (base ref + optional region scope + maxResults); full input + structured
      output; classified `conclusion` in `tool-contract.ts`; full preset only (not minimal/navigation).
      Cursor is the ref, not wall-clock.
- [x] CLI equivalent `openlore briefing-since` (`--base`, `--file-pattern`, `--max`, `--json`).

## 4. Tests & fixtures
- [x] Stable hub modified among trivial changes → surfaces top as `surprising-change`.
- [x] Shallow history → surprising label withheld; ranks as `hub-change`/`chokepoint-change`.
- [x] Over-bound change set → receipt reports dropped count + lowest tier; higher tiers retained.
- [x] Determinism: byte-identical briefing core for a fixed ref pair (unit + real-repo dogfood).

## 5. Verify & dogfood
- [x] `npm run lint`, `npm run typecheck`, `npm run test:run` (5221 pass), `npm run build` green.
- [x] Dogfood: `briefing-since --base HEAD~8` on this repo — stable hubs (writeStdout, getLineNumber)
      surface as `surprising-change`, god-orchestrators (handleOrient, build) as `hub-change`, pure
      funnels (findEnclosingFunction fanIn=27) as `chokepoint-change`; receipt + tests-to-run + staleness
      caveat all fire; deterministic across two runs; region scope verified.

## 6. Docs
- [x] Document the tool, the label tiers + evidence, the no-silent-truncation receipt, and the
      labels-not-scores discipline (docs/mcp-tools.md, docs/cli-reference.md, CLAUDE.md table, README).
- [x] Update the MCP tool count guard (68 → 69 across guarded docs) + payload budget (76k → 78k) +
      live-data tool-driver registry.
