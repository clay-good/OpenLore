# Tasks — add-env-config-impact-graph

## 1. Extractor
- [x] Add `EnvReadSite` type + `extractEnvReadSites(content, relPath, ext)` to `env-extractor.ts`,
      reusing the existing per-language regexes; per-site `required` via a window scan after the match.
- [x] Unit tests in `env-extractor.test.ts` for each language + the fallback / strict distinction.

## 2. Handler
- [x] `src/core/services/mcp-handlers/env-impact.ts` — `handleAnalyzeEnvImpact`:
      resolve var (cached inventory artifact → live extraction fallback), re-scan its files,
      map read sites → enclosing function (line containment), backward BFS for blast radius + tests,
      module-level disclosure, sound boundaries.
- [x] Handler tests `env-impact.test.ts` (resolve/not-found/module-level/blast-radius/opt-in).

## 3. Wiring
- [x] `mcp.ts`: `TOOL_DEFINITIONS` entry + `TOOL_ANNOTATIONS` (`_RO`).
- [x] `tool-dispatch.ts`: dispatch case + import.
- [x] `tool-contract.ts`: classify `analyze_env_impact: 'conclusion'`.
- [x] `epistemic-lease.ts`: weight (3, structural-heavy).
- [x] `live-data/tool-driver.ts`: driver entry.
- [x] CLI `src/cli/commands/env-impact.ts` + register in `src/cli/index.ts`.

## 4. Guards
- [x] Bump full-surface payload budget in `mcp-presets.test.ts` (82_000 → new ceiling) with a comment.
- [x] Update documented tool count 71 → 72 across guarded docs + the `~N KB / ~Nk tokens` figure.

## 5. Verify
- [x] `npm run build` clean.
- [x] `vitest run src examples` green.
- [x] Dogfood e2e (`openlore env-impact` + MCP tool) on the OpenLore repo + a multi-language corpus;
      record `DOGFOOD-env-config-impact-graph.md`.

## 6. Docs / status
- [x] README MCP-tools table + CLAUDE.md table row.
- [x] `docs/mcp-tools.md` + `docs/cli-reference.md` entries.
- [x] Mark proposal IMPLEMENTED with as-built notes.
