# Rename: spec-gen → OpenLore

> **Historical — completed.** The rename to OpenLore shipped long ago; this checklist is kept for the
> record only. For current docs start at the [documentation index](README.md) and [install.md](install.md).

> Source-of-truth checklist for renaming this project from **spec-gen** to **OpenLore**.
>
> Status: **Planning** — this document lands first (PR 1). The actual rename lands in a follow-up PR (PR 2). After merge, the codebase is re-analyzed to verify 0 residual `spec-gen` references.

## Context

The name *spec-gen* undersells what the tool actually does. Spec generation is one capability inside a broader system: persistent architectural memory for AI agents (call graph orientation, drift detection, decision gates, graph-native MCP tooling). "OpenLore" — lore as accumulated codebase knowledge — better captures that, keeps the `Open*` naming aligned with the OpenSpec ecosystem, and is free on npm and GitHub.

Decision reached over email between Clay Good (author) and Laurent Francoise (contributor), May 10 2026.

## Rename strategy

- **Hard rename, no deprecated alias.** The CLI binary, npm package, hidden working directory, env vars, and slash commands all flip to `openlore` in one release. No `spec-gen` compatibility shims are added. Users perform a one-time `mv .spec-gen .openlore` and `npm i -g openlore`; both are documented in release notes.
- **Spec-only PR first.** This document is PR 1 — review the checklist before changing 700+ references. The mechanical rename happens in PR 2.
- **Verification after merge.** Re-analyze the repo post-merge; the success criterion is zero matches for `spec-gen`, `specGen`, `SpecGen`, `SPEC_GEN` across tracked files (excluding this doc, CHANGELOG entries, and historical git data).

## Name mappings

The canonical replacement for every casing variant:

| Old | New |
|---|---|
| `spec-gen` (kebab) | `openlore` |
| `spec_gen` (snake) | `openlore` |
| `specGen` (camel) | `openlore` |
| `SpecGen` (pascal) | `OpenLore` |
| `SPEC_GEN` (constant) | `OPENLORE` |
| `spec-gen-cli` (npm) | `openlore` |
| `.spec-gen/` (dir) | `.openlore/` |
| `.spec-gen-ignore` (file) | `.openlore-ignore` |

## Checklist

Each section is a category from the rename inventory. Check items off in PR 2 as they land. Counts are approximate; the goal is **0 remaining matches** at the end, not hitting a specific number.

### 1. Package metadata — [package.json](../package.json)

- [ ] `name`: `spec-gen-cli` → `openlore`
- [ ] `bin`: `{ "spec-gen": ... }` → `{ "openlore": ... }`
- [ ] `description`: keep, or refresh to mention OpenLore's broader scope
- [ ] `repository.url`: `https://github.com/clay-good/spec-gen` → new repo URL (TBD — see "Open items" below)
- [ ] `bugs.url`: same
- [ ] `homepage`: same
- [ ] `keywords`: consider adding `openlore`, `architectural-memory`

### 2. CLI binary & command examples

All occurrences of `spec-gen <subcommand>` become `openlore <subcommand>`:

- [ ] [README.md](../README.md) — ~35 references
- [ ] [AGENTS.md](../AGENTS.md) — ~50 references
- [ ] [CLAUDE.md](../CLAUDE.md) — 2 references (incl. `@.spec-gen/analysis/CODEBASE.md`)
- [ ] [CONTRIBUTING.md](../CONTRIBUTING.md) — 2 references
- [ ] All [docs/](../docs/) files (see §6)
- [ ] All [examples/](../examples/) files (see §8)

### 3. Source code identifiers

#### Constants — [src/constants.ts](../src/constants.ts)

- [ ] `SPEC_GEN_DIR` → `OPENLORE_DIR`
- [ ] `SPEC_GEN_ANALYSIS_SUBDIR` → `OPENLORE_ANALYSIS_SUBDIR`
- [ ] `SPEC_GEN_LOGS_SUBDIR` → `OPENLORE_LOGS_SUBDIR`
- [ ] `SPEC_GEN_VERIFICATION_SUBDIR` → `OPENLORE_VERIFICATION_SUBDIR`
- [ ] `SPEC_GEN_OUTPUTS_SUBDIR` → `OPENLORE_OUTPUTS_SUBDIR`
- [ ] `SPEC_GEN_BACKUPS_SUBDIR` → `OPENLORE_BACKUPS_SUBDIR`
- [ ] `SPEC_GEN_GENERATION_SUBDIR` → `OPENLORE_GENERATION_SUBDIR`
- [ ] `SPEC_GEN_RUNS_SUBDIR` → `OPENLORE_RUNS_SUBDIR`
- [ ] `SPEC_GEN_CONFIG_FILENAME` → `OPENLORE_CONFIG_FILENAME`
- [ ] `SPEC_GEN_CONFIG_REL_PATH` → `OPENLORE_CONFIG_REL_PATH`
- [ ] `SPEC_GEN_ANALYSIS_REL_PATH` → `OPENLORE_ANALYSIS_REL_PATH`
- [ ] `SPEC_GEN_DECISIONS_SUBDIR` → `OPENLORE_DECISIONS_SUBDIR`

#### Types & interfaces — [src/types/index.ts](../src/types/index.ts) and consumers

- [ ] `SpecGenConfig` → `OpenLoreConfig`
- [ ] `SpecGenMetadata` → `OpenLoreMetadata`
- [ ] Update all import sites

#### Functions

- [ ] `specGenAnalyze` → `openloreAnalyze`
- [ ] `specGenGenerate` → `openloreGenerate`
- [ ] `specGenDrift` → `openloreDrift`
- [ ] `specGenRun` → `openloreRun`
- [ ] `specGenVerify` → `openloreVerify`
- [ ] `specGenAudit` → `openloreAudit`
- [ ] `specGenGetSpecRequirements` → `openloreGetSpecRequirements`
- [ ] `specGenInit` → `openloreInit`
- [ ] `readSpecGenConfig` → `readOpenLoreConfig`
- [ ] `updateWithSpecGenMetadata` → `updateWithOpenLoreMetadata`

Files containing these identifiers (~285 references total):

- [src/api/](../src/api/) — `generate.ts`, `init.ts`, `run.ts`, `drift.ts`, `verify.ts`, `specs.ts`, `audit.ts`, `analyze.ts` and their tests
- [src/core/generator/](../src/core/generator/) — `openspec-compat.ts`, `openspec-writer.ts`, `spec-pipeline.ts`, `mapping-generator.ts` and their tests
- [src/core/services/](../src/core/services/) — `config-manager.ts`, `llm-service.ts` and their tests
- [src/core/test-generator/scenario-parser.ts](../src/core/test-generator/scenario-parser.ts)
- [src/core/analyzer/ai-config-generator.ts](../src/core/analyzer/ai-config-generator.ts)

### 4. Hidden working directory `.spec-gen/` → `.openlore/`

The directory layout is preserved; only the top-level name changes.

```
.openlore/
├── config.json
├── analysis/         (CODEBASE.md, call-graph.db, dependency-graph.json, repo-structure.json, mapping.json, ...)
├── logs/
├── verification/
├── outputs/
├── backups/
├── generation/
├── runs/
└── decisions/        (pending.json)
```

- [ ] Update all ~145 hardcoded path strings (`.spec-gen/...`) across `src/cli/`, `src/api/`, `src/core/`, `docs/`, `examples/`, tests
- [ ] Update [CLAUDE.md](../CLAUDE.md) imports: `@.spec-gen/analysis/CODEBASE.md` → `@.openlore/analysis/CODEBASE.md`
- [ ] Update `.gitignore` recommendations in docs
- [ ] Rename optional user file `.spec-gen-ignore` → `.openlore-ignore` in [src/core/analyzer/file-walker.ts](../src/core/analyzer/file-walker.ts)
- [ ] Release notes: document the one-time `mv .spec-gen .openlore` step

### 5. Skills & MCP / slash-command names

Rename files and update internal `name:`/`description:` frontmatter and any slash-command strings:

- [ ] [skills/spec-gen-analyze-codebase.md](../skills/spec-gen-analyze-codebase.md) → `skills/openlore-analyze-codebase.md`
- [ ] [skills/spec-gen-plan-refactor.md](../skills/spec-gen-plan-refactor.md) → `skills/openlore-plan-refactor.md`
- [ ] [skills/spec-gen-execute-refactor.md](../skills/spec-gen-execute-refactor.md) → `skills/openlore-execute-refactor.md`
- [ ] [skills/spec-gen-implement-feature.md](../skills/spec-gen-implement-feature.md) → `skills/openlore-implement-feature.md`
- [ ] [skills/claude-spec-gen.md](../skills/claude-spec-gen.md) → `skills/claude-openlore.md`
- [ ] All `/spec-gen-*` slash-command references in code and docs → `/openlore-*`

### 6. Documentation — [docs/](../docs/)

~65 references across:

- [ ] [docs/agent-setup.md](../docs/agent-setup.md)
- [ ] [docs/drift-detection.md](../docs/drift-detection.md)
- [ ] [docs/OPENSPEC-INTEGRATION.md](../docs/OPENSPEC-INTEGRATION.md)
- [ ] [docs/api.md](../docs/api.md)
- [ ] [docs/cli-reference.md](../docs/cli-reference.md)
- [ ] [docs/mcp-tools.md](../docs/mcp-tools.md) — also includes ~6 raw GitHub URLs (curl fetches)
- [ ] [docs/configuration.md](../docs/configuration.md)
- [ ] [docs/semantic-search.md](../docs/semantic-search.md)
- [ ] [docs/output.md](../docs/output.md)
- [ ] [docs/viewer.md](../docs/viewer.md)
- [ ] [docs/ci-cd.md](../docs/ci-cd.md)
- [ ] [docs/providers.md](../docs/providers.md)
- [ ] [docs/TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md)
- [ ] [docs/REFACTORING-WORKFLOW.md](../docs/REFACTORING-WORKFLOW.md)
- [ ] [docs/AGENT-ADOPTION.md](../docs/AGENT-ADOPTION.md)
- [ ] [docs/pipeline.md](../docs/pipeline.md)

### 7. Tests

~65 references in test files (run `npm run test:run` after rename; failures are likely string-asserting tests):

- [ ] [src/core/analyzer/ai-config-generator.test.ts](../src/core/analyzer/ai-config-generator.test.ts)
- [ ] [src/core/analyzer/file-walker.test.ts](../src/core/analyzer/file-walker.test.ts)
- [ ] [src/core/drift/drift-detector.test.ts](../src/core/drift/drift-detector.test.ts)
- [ ] [src/core/generator/mapping-generator.test.ts](../src/core/generator/mapping-generator.test.ts)
- [ ] [src/core/generator/openspec-writer.test.ts](../src/core/generator/openspec-writer.test.ts)
- [ ] [src/core/services/config-manager.test.ts](../src/core/services/config-manager.test.ts)
- [ ] [src/core/services/gitignore-manager.test.ts](../src/core/services/gitignore-manager.test.ts)
- [ ] [src/core/services/mcp-watcher.test.ts](../src/core/services/mcp-watcher.test.ts)
- [ ] [src/core/services/mcp-handlers/analysis.test.ts](../src/core/services/mcp-handlers/analysis.test.ts)
- [ ] [src/cli/commands/analyze.integration.test.ts](../src/cli/commands/analyze.integration.test.ts)
- [ ] [src/cli/commands/analyze.test.ts](../src/cli/commands/analyze.test.ts)
- [ ] [src/cli/commands/init.test.ts](../src/cli/commands/init.test.ts)
- [ ] [src/cli/commands/mcp.test.ts](../src/cli/commands/mcp.test.ts)
- [ ] [src/cli/commands/view.test.ts](../src/cli/commands/view.test.ts)
- [ ] [src/cli/commands/drift.test.ts](../src/cli/commands/drift.test.ts)
- [ ] [src/api/api.test.ts](../src/api/api.test.ts)
- [ ] [src/api/init.test.ts](../src/api/init.test.ts)

### 8. Examples & plugins — [examples/](../examples/)

#### opencode plugins ([examples/opencode/plugins/](../examples/opencode/plugins/))

- [ ] Rename `spec-gen-decision-extractor.ts` → `openlore-decision-extractor.ts` (+ `.test.ts`)
- [ ] Rename `spec-gen-context-injector.ts` → `openlore-context-injector.ts` (+ `.test.ts`)
- [ ] Rename `spec-gen-enforcer.ts` → `openlore-enforcer.ts`
- [ ] Rename `lib/spec-gen-decision-extractor-helpers.ts` → `lib/openlore-decision-extractor-helpers.ts`
- [ ] Rename `lib/spec-gen-context-injector-helpers.ts` → `lib/openlore-context-injector-helpers.ts`
- [ ] Update internal identifiers (`_specGenBin`, `SPEC_GEN_BIN`, `execSync('spec-gen ...')`)

#### Skills examples

- [ ] [examples/mistral-vibe/skills/spec-gen-*/SKILL.md](../examples/mistral-vibe/skills/) — rename dirs + content
- [ ] [examples/opencode-skills/spec-gen-*/SKILL.md](../examples/opencode-skills/) — rename dirs + content
- [ ] [examples/cline-workflows/spec-gen-*.md](../examples/cline-workflows/) — rename files + content

#### spec-kit

- [ ] [examples/spec-kit/extension.yml](../examples/spec-kit/extension.yml) — command IDs `speckit.spec-gen.orient` → `speckit.openlore.orient`, `speckit.spec-gen.drift` → `speckit.openlore.drift`

### 9. Env vars & git sentinels

- [ ] `.git/SPEC_GEN_GATE_RAN` sentinel → `.git/OPENLORE_GATE_RAN` ([src/cli/commands/decisions.ts](../src/cli/commands/decisions.ts), [docs/ci-cd.md](../docs/ci-cd.md))
- [ ] Audit for any future `SPEC_GEN_*` / `SPECGEN_*` env vars (none found at planning time, but re-check)

### 10. OpenSpec metadata key

- [ ] [src/core/generator/openspec-compat.ts](../src/core/generator/openspec-compat.ts): config key `'spec-gen'?: SpecGenMetadata` → `'openlore'?: OpenLoreMetadata`. No fallback for the old key — release notes call out the breaking change.

### 11. URLs

- [ ] Replace all `github.com/clay-good/spec-gen` URLs with the new repo URL across [package.json](../package.json), [README.md](../README.md), [CONTRIBUTING.md](../CONTRIBUTING.md), [docs/TROUBLESHOOTING.md](../docs/TROUBLESHOOTING.md), [docs/mcp-tools.md](../docs/mcp-tools.md), example SKILL.md files
- [ ] Verify raw-content curl URLs in docs/mcp-tools.md still resolve after repo rename

### 12. Repo-level files

- [ ] Move/rename the legacy planning artifact at [.spec-gen/refactor-plan.md](../.spec-gen/refactor-plan.md) along with the `.spec-gen/` → `.openlore/` rename
- [ ] [.gitignore](../.gitignore) — confirm no stale `.spec-gen` references after rename
- [ ] [flake.nix](../flake.nix) — check for package/binary references

## Out of scope (handled separately, not part of PR 2)

- **GitHub repo rename** (clay-good/spec-gen → clay-good/openlore): Clay handles via GitHub UI after PR 2 merges. Redirects will keep old URLs working temporarily.
- **npm publish** of the new `openlore` package: Clay handles after PR 2 merges and the repo is renamed.
- **Deprecation notice on `spec-gen-cli`** on npm: post-publish step, points users at `openlore`.

## Verification (after PR 2 merge)

Re-analyze the codebase. Success criteria:

```sh
# Should return 0 results in tracked files (excluding this doc, CHANGELOG, .git/):
git grep -i -E 'spec[-_]?gen' -- ':!docs/RENAME-TO-OPENLORE.md' ':!CHANGELOG*'
```

Plus:

- [ ] `npm run typecheck` passes
- [ ] `npm run test:run` passes
- [ ] `npm run build` produces a working `dist/cli/index.js` invokable as `openlore`
- [ ] `openlore analyze` runs end-to-end on this repo and writes to `.openlore/`
- [ ] MCP server registers under the new name and `orient` tool still works

## Open items

- **New GitHub repo URL** — assumed `https://github.com/clay-good/openlore`. Confirm before PR 2.
- **Version bump** — recommend `2.0.0` for the rename release given the breaking changes (npm name, CLI binary, directory layout, OpenSpec config key). Confirm SemVer policy before publishing.
