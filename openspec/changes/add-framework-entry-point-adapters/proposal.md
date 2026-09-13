# Framework entry-point adapters: config-wired code stops reading as orphaned

> Status: BUILT (2026-09-12), narrowed — see *Scope as built*. Originally PROPOSED (2026-07-03, e2e audit follow-up). Deterministic config-file readers that mark
> files/symbols as externally referenced — package.json `bin`/`main`/`exports`, npm scripts, test
> runner configs, CI workflow `run:` steps — so wiring that never appears as an import stops
> inflating entry-point and dead-code candidates. Prior art: knip (https://knip.dev/), whose ~150
> declarative plugins encode exactly this knowledge; we borrow the MECHANISM (config readers as
> liveness evidence), not the plugin count. No LLM, no constants, adapters only ever ADD evidence
> of use.

## The gap

The graph reports **695 entry points (no internal callers)** (CODEBASE.md digest; computed as
not-called at `src/core/analyzer/call-graph.ts:4495-4497`, rendered at
`src/core/analyzer/codebase-digest.ts:137-140`), and `find_dead_code` returns *candidates*
precisely because config wiring is invisible. Its roots today are tests · symbols imported by
another file · HTTP route handlers · synthesized route handlers · main-like functions
(`src/core/services/mcp-handlers/reachability.ts:226-236`), and its honest-limits header and
caveats name the rest as blind spots (`reachability.ts:14-30`, `:402-403`: framework routing and
externally-consumed exports "can still produce false 'dead' positives"). What no root covers, on
this very repo: the CLI entry named by package.json `bin`, files invoked by npm `scripts`,
vitest setup/config references, and scripts run by CI workflow steps. Downstream,
`report_coverage_gaps` labels a gap `also-dead` vs `untested-not-dead`
(`mcp-handlers/coverage-gaps.ts:24`, `:96`) using the same roots, so its labels inherit the same
blindness.

## What changes

**A staged, small adapter set — deterministic readers of config formats, each producing
"externally referenced" liveness evidence that extends the existing roots definition** (the
mechanism at `reachability.ts:232-236` — adapters add a root kind, nothing else changes):

- **Stage 1 — package manifest:** package.json `bin` / `main` / `module` / `exports` targets, and
  npm `scripts` entries that invoke local files (`node scripts/x.js`, `tsx tools/y.ts`).
- **Stage 2 — tool configs:** vitest/jest `setupFiles` / `globalSetup` / include globs;
  tsconfig `files` / `references`.
- **Stage 3 — CI workflows:** GitHub Actions `run:` steps that invoke repo scripts. The IaC
  projector already parses workflows and action metadata
  (`src/core/analyzer/iac/github-actions.ts` — jobs, `needs:`, `uses:`, with `${{ }}` masking);
  it does NOT currently extract `run:` script paths, so this stage extends that parser's
  step handling — reusing its masked-YAML parse — rather than re-parsing workflows.
- **Framework route conventions** (Next/Nuxt-style file routing) are explicitly deferred and
  disclosed as a remaining boundary — the honest-limits caveat shrinks, it does not vanish.

**Effect on conclusions:**

- `find_dead_code`: a config-wired symbol leaves candidate-dead with a new `externally-wired`
  root kind, counted in `rootKinds` (`reachability.ts:382-386`) and carrying its adapter receipt
  (which config file, which key) so the exclusion is auditable, not asserted.
- `report_coverage_gaps`: `also-dead` vs `untested-not-dead` sharpens — a config-wired untested
  entry point is `untested-not-dead` with the receipt, no longer mislabeled `also-dead`.
- The map/CODEBASE.md entry-points digest distinguishes "config-wired" from "true orphan"
  (`codebase-digest.ts:137-140`), so the 695 figure decomposes into meaning.

**Honesty clauses:** an adapter only ever REMOVES false dead-candidates by adding evidence of
use — it never asserts deadness (the existing "prefer false-live over false-dead" root doctrine,
`reachability.ts:226`). Unrecognized config formats, dynamic references (`node $SCRIPT`), and
globs that fail to resolve are disclosed boundaries, never guesses. Deliberately NOT borrowed
from knip: its `--fix` auto-deletion (nothing is ever auto-deleted — `reachability.ts:28`), its
JS-ecosystem-only scope framing, and the 150-plugin ambition — adapters stay a small set of
format parsers, each deterministic and individually testable.

## Scope as built

- **Built:** one module, `src/core/analyzer/entry-point-adapters.ts`, with three stages:
  - the root `package.json` (`bin`, `main`, `module`, `exports`, `scripts`, `jest`), with a build
    output mapped back to its source through tsconfig `outDir` → `rootDir` before the literal path;
  - `tsconfig.json` `files` and literal vitest/vite/jest `setupFiles` / `globalSetup` values;
  - `.github/workflows` `run:` steps, through the workflow parser's `${{ }}` masking, relative to each
    step's working directory.
- **Roots:** every function in a wired file is an `externally-wired` root. The call graph has no node
  for module-scope code, so what a wired file runs at load time cannot be told from its helpers; the
  roots doctrine prefers false-live over false-dead.
- **Consumers:** `find_dead_code` (`rootKinds.externallyWired`, an `externalWiring` receipt block,
  scope and boundary caveats), `report_coverage_gaps` (`externallyWired` receipts on a gap), and the
  CODEBASE.md entry-point line (config-wired count).
- **Measured on this repository:** 38 of 1,018 entry points are in files a config invokes; 53 files are
  wired, and 7 references are disclosed boundaries (a `cd` inside a multi-line CI script and a shell
  variable).
- **Deferred:** tsconfig `references` (they name projects, not code files), workspace-member manifests,
  framework route conventions, and literal values the config builds at runtime. The first two and the
  route conventions are named in the `find_dead_code` caveats.

## Why this is in scope

`find_dead_code`'s candidates and the entry-point inventory are existing conclusions whose
largest disclosed error source is config wiring; closing it with deterministic file readers is
precision work on the substrate's own doctrine (candidates → fewer, receipted candidates), with
zero new surface and zero constants.

## Impact

- Files: a new `src/core/analyzer/entry-point-adapters/` (stage parsers + tests),
  `mcp-handlers/reachability.ts` (root kind + receipts), `mcp-handlers/coverage-gaps.ts` (label
  join), `src/core/analyzer/codebase-digest.ts` (orphan vs config-wired),
  `src/core/analyzer/iac/github-actions.ts` (step-script extraction, stage 3).
- Specs: `analyzer` — 1 ADDED requirement (FrameworkEntryPointAdapters).
- Tool surface: unchanged (no new tool, no payload-budget impact).
- Risk: adapter false positives keep dead code alive (acceptable by doctrine: false-live over
  false-dead); config formats drift upstream (mitigated: per-adapter fixtures, unrecognized
  shapes fall to a disclosed boundary).
