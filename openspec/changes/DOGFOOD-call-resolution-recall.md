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

## 29 symbols recovered from the false-dead / false-entry-point list

Comparing per-symbol `fanIn` before vs after, **29 internal symbols went from `fanIn = 0` (a reported
dead-code candidate / entry point) to having real callers** — because a method or static call through an
imported receiver only binds once the import map is threaded into call-edge resolution. The most
striking:

| symbol | file | fanIn before | fanIn after |
|---|---|---:|---:|
| `EdgeStore.open` | `src/core/services/edge-store.ts` | 0 | 22 |
| `EdgeStore.dbPath` | `src/core/services/edge-store.ts` | 0 | 22 |
| `logger.warning` | `src/utils/logger.ts` | 0 | 47 |
| `logger.success` | `src/utils/logger.ts` | 0 | 34 |
| `logger.discovery` | `src/utils/logger.ts` | 0 | 22 |

`EdgeStore.open` — one of the most-called methods in the codebase — was being reported as having *zero
callers* (a false dead-code candidate and a false entry point). This is exactly the failure mode the
proposal set out to fix: "find_dead_code then reports live implementations as dead."

## Adversarial finding: an incremental-watcher parity bug (found and fixed)

A new adversarial parity scenario (`mcp-watcher-parity.test.ts` Scenario 4) revealed that a re-export
barrel a caller imports through is **neither the changed file nor a caller of it**, so it was absent from
an incremental rebuild's file subset. `buildResolvedImportMap` then could not follow the chain, and an
edge a full rebuild resolved at `re_export` silently degraded to `name_only` on the next incremental
edit — violating the incremental↔full parity (converge-or-flag) invariant. Fixed by
`collectReExportBarrels`: `buildGraphSubset` now pulls in just the barrel files (followed along the
chain, for export-indexing only; their own edges are filtered out so nothing extra is persisted). The
new scenario asserts the incremental store now agrees with `analyze --force`.

## A concrete barrel resolution

`src/core/generator/spec-pipeline.ts` calls `isTestFile`, imported from
`../analyzer/artifact-generator.js`, which re-exports it (`export { isTestFile } from './test-file.js'`)
from `src/core/analyzer/test-file.ts`. Before: the call fell through to `name_only`, ambiguously bound by
name. After: it resolves to `test-file.ts::isTestFile` at `re_export` confidence — the barrel hop is
followed and disclosed.

## Full-product e2e dogfood (post-v2.1.3 surface)

A full first-run + new-feature dogfood on two clean third-party repos (read-only fixtures, restored
afterwards):

**vaulytica (2184-file TS monorepo):** `openlore install` wired the repo and built the index in 15.5s
(3889 functions); the MCP stdio server answered `initialize` → `tools/list` (10 nav / 66 full) →
`tools/call`; the five post-v2.1.3 tools (`get_language_support`, `report_coverage_gaps`,
`map_in_flight_conflicts`, `plan_parallel_work`, `change_impact_certificate`) all executed and returned
valid JSON; `coverage-gaps --json` was pure parseable JSON; `doctor`/`enforce`/`prove --estimate` worked;
install was idempotent (clean no-op, exactly one managed block) and `--uninstall` merge-aware. The
re-export feature held on a *different* large TS repo: `import` 1215, `re_export` 51, `name_only` only 23.

**onkos (Python + notebooks):** surfaced a real bug — Python produced **zero** `import`/`re_export`
edges (156 `name_only`). Root cause: leading-dot relative imports (`from .impl import x`) were not
resolved, and the called functions were imported *inside function bodies*, which the line-anchored parser
regex skipped. Fixed both; after `analyze --force`: `import` 0 → 102, `name_only` 156 → 58. This also
makes the language-support registry's Python `imports` claim functional.

**Second full-product pass (fresh repos: invariant Rust+IaC, mantissa-log 128 Terraform).** Verified:
install **merges** a pre-existing `CLAUDE.md` (original content kept, +18 lines, one managed block — no
clobber); Rust extraction (4626 functions); the IaC projectors — Docker (2 nodes), GitHub Actions (21
job nodes + 59 dependency edges), Terraform at scale (1407 nodes + 3548 edges across AWS/Azure/GCP);
idempotent re-install; `--json` purity across `orient`/`coverage-gaps`/`impact-certificate`/`blast-radius`.

**Bug found + fixed — `--json`/large output truncated at 64KB when piped.** `process.stdout` is async on
a pipe, so a command that wrote a large payload then `process.exit()`ed lost everything past the ~64KB
pipe buffer: `openlore review --format json` emitted a 100,535-byte briefing that arrived truncated to
exactly **65,536 bytes** and failed to parse — but was fine redirected to a file (synchronous writes), so
it only bit the pipe path agents actually use. `impact-certificate` was at 62,817 B — passing only by
luck, one repo away from the same break. Fixed with a `writeStdout` helper that awaits the flush
(resolving eagerly when the write is accepted without backpressure, awaiting the drain callback under
backpressure — the truncating case); the eight JSON-emitting CLIs await it before exit. Regression test
drives a 300KB payload through a real child-process pipe.

**Third bug found + fixed — HTML extractor O(N²).** Widening the "no quadratic scan" guard (a flaky
`<1s` perf test that reddened CI) exposed that `extractHtmlScripts` is genuinely quadratic on
unterminated `<script>` tags: each open tag re-scanned to EOF for a never-coming close tag (~24s on 100k
tags). Fixed by stopping the scan once no close tag remains from the current position to EOF (no later
open tag can have one) — back to O(N) (~17ms on 100k). A real `analyze`-stall risk on large/generated
HTML, latent behind a too-small test.

**Minor UX note (not changed):** during `install`, the internal `analyze` prints "Agent config files: not
generated — re-run with --ai-configs" moments before install's adapter creates `CLAUDE.md`/`AGENTS.md`
with the managed block. The message is scoped to analyze's `--ai-configs` digest (a different artifact),
but reads as misleading in the install flow; left as-is to avoid cross-flow output churn.

## Full-product dogfood pass 3 (breadth sweep — no new bugs)

A third pass exercised the surfaces the earlier passes hadn't, on a clean TS repo (agent-replay) plus the
repos above. All clean — no code change needed:

- **Determinism** — `analyze` then `analyze --force` produce a byte-identical edge-set hash.
- **SCIP export** — `export scip` emits a well-formed 72KB index (46 documents / 185 symbols / 642
  occurrences) with valid SCIP symbol descriptors (documented zero-width column-range limitation).
- **Warm daemon** — `serve` binds, answers `/health` and `POST /tool/orient` with valid JSON, writes
  `serve.json`, and shuts down cleanly; **`view`** serves the UI (HTTP 200, no errors).
- **Zero-config embeddings** — `embed --local` downloads + caches Xenova/all-MiniLM-L6-v2 and flips
  `orient` from BM25 to `searchMode: hybrid` / `retrievalMode: local-semantic`.
- **Graceful surfaces** — `digest` (needs specs), `decisions`, `federation list`, `manifest`,
  `plugin-manifest`, `panic-level`/`panic-check`, `preflight` all behave/exit cleanly; `node_modules` is
  excluded from the graph.
- **Incremental watcher (this PR's `buildGraphSubset`/`collectReExportBarrels`)** — a live edit on a real
  repo (adding a function) was picked up and added to the graph within seconds; no normal-edit regression.
- **Re-export feature on a third+fourth repo** — vaulytica (`import` 1215 / `re_export` 51 / `name_only`
  23) and agent-replay (`import` 279 / `name_only` 0) both resolve cross-file calls precisely.

## Full-product dogfood pass 4 (expanded scope — all parts; no new bugs)

A deliberately broad sweep across subsystems the earlier passes hadn't reached:

- **Language extraction (full matrix)** — a 14-file fixture covering every remaining call-graph language
  (Go, Java, Kotlin, C++, C, Ruby, C#, PHP, Swift, Scala, Lua, Bash, Elixir, Dart): each extracts its two
  functions and resolves the `helper()` call (`same_file`). TS/JS/Python/Rust were already covered on
  real repos.
- **MCP tool sweep (all 66)** — every tool called over stdio; 54 returned valid results and 12 correctly
  rejected deliberately-wrong/absent args with `-32602` validation errors. No crashes, no malformed
  output, no unhandled exceptions.
- **Degenerate inputs** — an empty repo (no source) analyzes in ~100ms; a repo mixing a syntax-error
  file, unicode identifiers (`café`), and a 100k-character line extracts the valid functions, preserves
  unicode names, skips the malformed one (tree-sitter error recovery), and does not hang.
- **Federation cross-repo** — `federation add`/`list` register two indexed repos; `federation_status`
  and `map_in_flight_conflicts` return valid JSON over the multi-repo host.
- **Decisions governance** — `record_decision` + `list_decisions` work (deterministic); `--consolidate`
  cleanly requires an LLM provider (graceful, documented).

All clean — no code change needed. Combined with passes 1–3 (Python relative imports, HTML O(N²),
`--json` pipe truncation — all fixed), the product is exercised end-to-end across install, MCP (66 tools),
18 languages, IaC ecosystems, CLIs, the warm daemon + viewer, on-device embeddings, the incremental
watcher, degenerate inputs, federation, and decisions.

## Verification

- New suite `call-resolution-recall.test.ts`: 19/19 pass (barrel, `export *`, depth-N, direct-stays-
  `import`, disambiguation, named-cycle + `export *`-cycle termination, determinism, TS/JS superset,
  regression gate, adversarial boundaries: package re-export not followed, barrel-local def wins,
  aliased-rename + default-re-export graceful degradation; plus Python leading-dot, parent-package, and
  function-level relative-import resolution). Parser regression test for indented imports in
  `import-parser.test.ts`.
- A second adversarial probe confirmed fail-soft behavior on `export *` cycles (resolve + terminate),
  default re-export through a barrel (graceful fallback, no wrong edge — deferred rename limitation), and
  chains deeper than `REEXPORT_MAX_DEPTH` (bounded; still finds a uniquely-named target via `name_only`).
- `mcp-watcher-parity.test.ts` Scenario 4 (re-export incremental parity): pass after the
  `collectReExportBarrels` fix.
- Full CI-mirror suite (`vitest run src examples`): 5068 pass, 2 skipped, all green. (A few
  git/timing-sensitive `.test.ts` files show occasional parallel-load flakiness — each passes in
  isolation and the failing set is non-deterministic across runs; unrelated to this change, whose
  resolution is determinism-tested.)
- `npm run lint`, `tsc --noEmit`, `npm run build`: clean.
