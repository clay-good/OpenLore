# Dogfood — call resolution recall (re-export / barrel resolution)

> 2026-06-25, branch `feat/call-resolution-recall`. Method: re-analyze this repository
> (`node dist/cli/index.js analyze`) before and after the change and diff the call-edge confidence
> distribution from `.openlore/analysis/call-graph.db`. This is a barrel-organized TypeScript codebase
> with ESM `.js` import specifiers — the exact shape the change targets.

## What the dogfood found (and fixed)

The first dogfood run after wiring the resolver in produced only **4** `import` call edges — almost no
change. Root cause: OpenLore's TS sources import with the ESM `.js` specifier (`import … from './x.js'`),
so the resolved target kept its `.js` extension while function nodes carry `.ts`, and the anchored prefix
match never fired. Fixed by stripping the module extension in `buildResolvedImportMap` (mirroring the
existing `tested_by` resolver). This is a bug the unit/integration fixtures (which used extensionless
imports) did not catch — only dogfooding on real sources surfaced it.

## Before → after (call edges, `kind = 'calls'`)

| confidence | before | after | delta |
|---|---:|---:|---:|
| `name_only` (ambiguous heuristic) | 1067 | 87 | **−980 (−92%)** |
| `import` (precise cross-file) | 0 | 1326 | **+1326** |
| `re_export` (barrel-crossed) | 0 | 21 | **+21** |
| `external` (unresolved leaf) | 8742 | 8563 | −179 |
| `same_file` | 2672 | 2713 | +41 |
| `synthesized` (CHA / dynamic) | 432 | 498 | +66 |
| `type_inference` | 85 | 85 | 0 (preserved) |

**1347 cross-file call edges** that were previously the ambiguous first-same-named-candidate
(`name_only`) or unresolved (`external`) now resolve to their true definition at strongly-resolved
confidence. Every conclusion that rests on the call graph — `find_dead_code`, `select_tests`,
`analyze_impact`, `blast_radius`, `report_coverage_gaps` — gets a more complete and more precise graph.

The directly-resolved `type_inference` edges are unchanged (85 → 85), and `same_file` only grew, never
shrank — the regression invariant ("no directly-resolved edge dropped or downgraded") holds on the real
graph, not just the fixtures.

## A concrete barrel resolution

`src/core/generator/spec-pipeline.ts` calls `isTestFile`, imported from
`../analyzer/artifact-generator.js`, which re-exports it (`export { isTestFile } from './test-file.js'`)
from `src/core/analyzer/test-file.ts`. Before: the call fell through to `name_only`, ambiguously bound by
name. After: it resolves to `test-file.ts::isTestFile` at `re_export` confidence — the barrel hop is
followed and disclosed.

## Verification

- New suite `call-resolution-recall.test.ts`: 12/12 pass.
- Full CI-mirror suite (`vitest run src examples`): 5063 pass, 2 skipped. (Pre-existing parallel-load
  flakiness in a few git/timing-sensitive `.test.ts` files: each fails only under full-suite contention,
  passes in isolation, and the failing set is non-deterministic across runs — unrelated to this change,
  whose resolution is covered by a determinism test.)
- `npm run lint`, `tsc --noEmit`, `npm run build`: clean.
