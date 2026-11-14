# Design: curate-product-surface

Facts were measured on 2026-11-14 at main 0dd75dbef. Sizes are bytes on disk, unpacked.

## Decisions

### D1. Four outcomes, and one test for "referenced"

- **Decision.** Each item gets SHIP IN PLUGIN, KEEP, MERGE or DELETE. An item is "referenced" when
  a tracked file under `src/`, `scripts/`, `docs/`, `.github/`, or one of `package.json`,
  `README.md`, `AGENTS.md`, `CLAUDE.md` names its path. A file that ships in the npm package must
  be referenced.
- **Why.** The rule is a grep. A builder and a reviewer get the same answer.
- **Rejected.** "Delete what looks old." No test can defend it.

### D2. `skills/<name>/SKILL.md` is the only source copy of a skill

- **Decision.** Loose `.md` files at the root of `skills/` are deleted. The two copies under
  `examples/` are deleted, and each folder keeps a 3-line `README.md` that names the new path.
  `plugin/skills/` is a build copy; its byte-identity test belongs to `adopt-agent-context-interop`.
- **Why.** Pi loads the whole folder (`package.json` `pi.skills`), so every loose file is offered
  to the agent. `openlore setup` already reads only `skills/<name>/SKILL.md`
  (`src/cli/commands/setup.ts:163`). The copies exist only for a test
  (`src/core/services/spec-workflow-skills.test.ts:157-163`) and a pack check
  (`scripts/audit-packlist.mjs:60-61`).
- **Rejected.** Keep the copies one more release. They have been byte-identical since 2026-08-30
  and nothing in the package reads them. See open question 1.

### D3. The plugin ships 5 skill folders, one per loop job

| Job in the agent loop | Skill folder | Lines today | Plugin | `openlore setup` | Pi |
|---|---|---|---|---|---|
| Orient before reading | `openlore-orient` | 72 | yes | no (as today) | yes |
| Implement | `openlore-implement-story` | 258 | yes | yes | yes |
| Debug a failure | `openlore-debug` | 289 | yes | yes | yes |
| Review before stop | `openlore-review-changes` | 132 | yes | yes | yes |
| Check with tests | `openlore-write-tests` | — | yes | yes | yes |
| Spec generate / repair | `openlore-generate` (16), `openlore-repair` (17) | 33 | no, until `spec-framework-neutrality` makes them format-neutral | yes | yes |
| Other workflows | `openlore-analyze-codebase`, `openlore-brainstorm`, `openlore-plan-refactor`, `openlore-execute-refactor` | — | no | yes | yes |

- **Why.** These 5 jobs are the inner loop: orient, implement, test, debug, review. The spec pair
  calls `prepare_spec_generation` / `prepare_spec_repair`, which are OpenSpec-only and outside the
  plugin tool set (`reframe-governance-as-agent-evidence`); it joins the plugin when
  `spec-framework-neutrality` ships. The other 4 are longer workflows that a user starts on purpose.
- **Rejected.** Ship all 11: the agent reads 11 descriptions every session. Ship the spec pair now:
  the plugin would need two OpenSpec-only tools. Ship `openlore-plan-refactor` in place of
  implement: the implement step would get no recipe.
- **Note.** `openlore-implement-story` and `openlore-debug` name tools outside the `substrate`
  preset today (`search_specs`, `check_spec_drift`, `audit_spec_coverage`). The cut to `substrate`
  tools, and to text that needs no spec framework, is `adopt-agent-context-interop` work.

### D4. Hide harness plumbing with Commander's `hidden` option

- **Decision.** Register `hook`, `statusline`, `check-edit`, `panic-check` and `panic-level` with
  `program.addCommand(cmd, { hidden: true })` in `src/cli/index.ts:226-285`. Name them in a new
  `HIDDEN_PLUMBING_COMMANDS` list in `src/cli/help-groups.ts`. Group titles do not change.
- **Why.** These 5 are run by hooks or the status line. Hidden commands still run and still answer
  `openlore <name> --help`. `docs/cli-reference.md` keeps them.
- **Rejected.** Remove or rename them: hook commands already written in user settings would break.
  New group titles ("Daily use"): churn in `help-groups.test.ts` for no gain.
- **Spec note.** `OptionalFeatureDependenciesDegradeAtTheirOwnCommand` has a scenario that says
  `--help` "lists every command". Its SHALL text says "list its commands". The new requirement
  states the hidden set. If the owner wants that scenario reworded, do it when this change archives.

Help groups after the change (55 shown, 5 hidden, 60 registered):

| Group | Count | Commands |
|---|---|---|
| Set up & run | 13 | `install`, `connect`, `init`, `analyze`, `embed`, `mcp`, `serve`, `doctor`, `status` (new), `features`, `setup`, `update`, `view` |
| Navigate the code | 3 | `orient`, `search`, `prove` |
| Govern a change | 16 | `blast-radius`, `impact-certificate`, `certify-public-surface`, `certify-service-contract`, `enforce`, `review`, `review-corpus`, `preflight`, `drift`, `decisions`, `change-status`, `coverage-gaps`, `working-set`, `briefing-since`, `footprint`, `handoff` (new) |
| Inspect & author specs | 11 | `audit`, `env-impact`, `error-propagation`, `find-clones`, `style-fingerprint`, `test`, `digest`, `generate`, `verify`, `run`, `mapping` (new) |
| Multi-repo & sharing | 5 | `federation`, `spec-store`, `export`, `import`, `manifest` |
| Advanced / experimental | 7 | `panic-validate`, `panic-hotspots`, `panic-calibrate`, `panic-replay`, `gryph-watch`, `telemetry`, `refresh-stories` |
| Hidden (callable) | 5 | `hook`, `statusline`, `check-edit`, `panic-check`, `panic-level` |

### D5. README: 7 sections, 120 lines or fewer

| # | Section | Lines | Source today |
|---|---|---|---|
| 0 | Title, one-line claim, badges | 10 | lines 1-35 |
| 1 | Install (plugin, npm, Pi) | 20 | "Install once, then forget it" |
| 2 | What happens on its own (the 4 moments) | 20 | "What you get" |
| 3 | What your agent can ask for (default pull tools) | 15 | "What your agent reaches for" |
| 4 | Limits and cost | 15 | "Known limitations" + "What it costs" |
| 5 | Languages | 5 | "Languages, Infrastructure-as-Code & contracts" → link |
| 6 | Documentation | 15 | "Documentation" |
| 7 | Development and community | 15 | "Development" + "Community" + "Links" |

- Moved out: "Value Scorecard" → `docs/AGENT-BENCHMARKS.md` (1 link line stays). "OpenLore vs.
  alternatives" and "Is OpenLore for you?" → `docs/PHILOSOPHY.md`.
- **Why.** Proof comes from daily use. The front page says what installs, what runs, and the limits.
- **Guards that read README today** must pass or move in the same task:
  `src/honesty-contract.test.ts:43-47` (scorecard heading and figures),
  `src/doc-claim-sync.test.ts:95` (language badge),
  `src/cli/commands/mcp-tool-count-doc.test.ts:58,78` (tool counts),
  `src/cli/commands/docs-index.test.ts`.
- **Rejected.** Delete the scorecard: its figures are guarded and `skills/openlore-orient` cites them.

### D6. Docs: the file with more inbound links or the later commit wins

Unique text moves into the winner. Then the other file is deleted and each inbound link is fixed
in the same task.

## Inventory

### `skills/` (19 entries)

| Item | Outcome | Reason | Replacement / who could rely on it |
|---|---|---|---|
| `openlore-orient/` | SHIP IN PLUGIN + KEEP (Pi) | Core recipe; 5 references | — |
| `openlore-implement-story/` | SHIP IN PLUGIN + KEEP (setup, Pi) | Implement step | — |
| `openlore-debug/` | SHIP IN PLUGIN + KEEP | Debug step | — |
| `openlore-review-changes/` | SHIP IN PLUGIN + KEEP | Review before stop | — |
| `openlore-generate/` | KEEP (setup, Pi); plugin later | Outer loop: write specs; needs `spec-framework-neutrality` first | — |
| `openlore-repair/` | KEEP (setup, Pi); plugin later | Outer loop: repair specs; needs `spec-framework-neutrality` first | — |
| `openlore-analyze-codebase/` | KEEP (setup, Pi) | Installed by `setup` | — |
| `openlore-brainstorm/` | KEEP | Installed by `setup` | — |
| `openlore-plan-refactor/` | KEEP | `docs/REFACTORING-WORKFLOW.md` | — |
| `openlore-execute-refactor/` | KEEP | Same | — |
| `openlore-write-tests/` | SHIP IN PLUGIN + KEEP | Test step of the loop; `src/cli/commands/test.ts`, 2 docs | — |
| `openlore-analyze-codebase.md` (4,301 b) | DELETE | Old form of the folder skill | Folder skill. Pi users only |
| `openlore-execute-refactor.md` (8,193 b) | DELETE | Old form | Folder skill. Pi users only |
| `openlore-plan-refactor.md` (8,238 b) | DELETE | Old form | Folder skill. Pi users only |
| `openlore-implement-feature.md` (6,707 b) | DELETE | No installer reads it | Pi: `openlore-implement-story`. Cline: `examples/cline-workflows/openlore-implement-feature.md` (still installed by `setup`) |
| `claude-openlore.md` (6,281 b) | DELETE | Superseded by `openlore-generate` | `openlore-generate`. Readers of `docs/mcp-tools.md:259` (fixed in task 1.2) |
| `openspec-skill.md` (6,430 b) | DELETE | OpenSpec owns its authoring skill | OpenSpec's own tooling; `search_specs`. `AGENTS.md:241` and `docs/mcp-tools.md:260` (fixed in 1.2) |
| `story-to-change.md` (2,904 b) | DELETE | 0 references | `openlore-brainstorm` writes the story; the spec framework proposes the change |
| `spec-workflow-protocol.md` (783 b) | MERGE → `openlore-generate`, `openlore-repair` | 0 references; 7 bullets | The 2 skills state the same rules |

Total removed: 8 files, 43,837 bytes.

### `examples/` (13 folders, 907 KB today)

| Item | Size | Outcome | Reason | Replacement / who could rely on it |
|---|---|---|---|---|
| `bmad/` | 36.8 KB | KEEP | `setup.ts` installs it | — |
| `cline-workflows/` | 43.1 KB | KEEP | `setup.ts` installs it | — |
| `gsd/` | 13.1 KB | KEEP | `setup.ts` installs it | — |
| `opencode/` | 65.3 KB | KEEP; 2 test files leave the package (12.8 KB) | `setup.ts` installs the plugin; the tests run in CI (`ci.yml:267`) | Tests stay in the repository |
| `ci/` | 2.0 KB | KEEP | `docs/preflight.md`, `preflight.test.ts` | — |
| `pi/` | 9.8 KB | KEEP | `docs/install.md`, `docs/cli-reference.md` | — |
| `spec-kit/` | 12.4 KB | KEEP | 3 docs link it; shows a second spec framework | — |
| `mistral-vibe/` README + template | 5.9 KB | KEEP | Docs link it | — |
| `mistral-vibe/skills/` | 70.9 KB | DELETE, leave a `README.md` stub | Byte-identical copy | `skills/<name>/SKILL.md` or `openlore setup --tools vibe`. Scripts that read the old path |
| `opencode-skills/` | 70.9 KB | DELETE, leave a `README.md` stub | Byte-identical copy | `skills/<name>/SKILL.md` or `openlore setup --tools opencode`. Scripts that read the old path |
| `drift-demo/` | 21.3 KB | DELETE | 0 references | `docs/drift-detection.md`. No doc names it |
| `drift-test/` | 33.9 KB | DELETE | 0 references; last commit 2026-05-12 | `openlore drift` on your own repository |
| `openspec-analysis/` | 491.7 KB | DELETE | 0 references; holds absolute paths of a developer machine | Run `openlore analyze` for current output |
| `openspec-cli/` | 30.1 KB | DELETE | 0 references | Run `openlore generate` for current output |

Leaves the package: 577.0 + 141.8 + 12.8 = 731.6 KB from `examples/`, plus 43.8 KB of loose
skills: about 775 KB. `examples/` in the package goes from 907 KB to about 176 KB.

`package.json` `files` afterwards:

```
"dist", "!dist/**/*.test.*", "scripts/postinstall.mjs", "src/viewer", "!src/viewer/**/*.test.*",
"examples/bmad", "examples/ci", "examples/cline-workflows", "examples/gsd", "examples/mistral-vibe",
"examples/opencode", "examples/opencode-skills", "examples/pi", "examples/spec-kit",
"!examples/**/*.test.*", "skills", "!skills/.DS_Store", "stubs", "schemas", "README.md", "LICENSE"
```

### `stubs/` and `scripts/`

| Item | Outcome | Reason |
|---|---|---|
| `stubs/tree-sitter-cli-stub/` | KEEP | `package.json` `overrides` |
| `postinstall.mjs` | KEEP (ships) | `postinstall` script |
| `copy-assets.mjs`, `audit-gate.mjs`, `audit-packlist.mjs`, `audit-dependencies.mjs` + `.d.mts`, `backfill-lock-integrity.mjs`, `api-consumer-smoke.mjs`, `optional-absence-register.mjs`, `optional-absence-hook.mjs`, `windows-unit-report.mjs` | KEEP | Build, CI or `prepublishOnly` |
| `diagnose-windows-daemon.ps1` | KEEP | `docs/windows-support.md` |
| `update-homebrew-formula.mjs` | KEEP | Release step (`homebrew:formula`) |
| `update-flake.sh` | KEEP; add a reference in `docs/publishing.md` | Keeps `flake.nix` in step; no file names it today |
| `install-skill.js` | KEEP | `skill:install-local`; the only installer of `openlore-orient` outside the plugin |
| `bench.ts`, `bench-mcp.ts`, `bench-watch.ts`, `bench-agent.ts`, `bench-agent.tasks.ts`, `BENCHMARKS.md`, `bench-preset-surface.ts`, `bench-preset-selection.ts`, `bench-preset-completion.ts`, `bench-reachability.mjs`, `verify-reachability-equivalence.mjs`, `measure-certified-scale.ts` | KEEP | Not shipped; tests and docs name 4 of them. See open question 3 |

No script is deleted. Only `postinstall.mjs` ships, so no user sees the others.

### `docs/`

| Item | Outcome | Reason | Replacement and link fixes |
|---|---|---|---|
| `languages.md` (4 L) | DELETE | Redirect stub; 0 inbound links | `language-support.md`. Update `src/cli/commands/docs-index.test.ts:65-70` |
| `agentic-workflows.md` (14 L) | MERGE → `agentic-workflows/README.md` | Same table; 4 example READMEs link the folder | Fix `docs/README.md:80`, `src/core/services/feature-inventory.ts:168` (→ `docs/install.md`), `docs/agent-setup.md:239-251` (→ 1 link line) |
| `agentic-workflows/README.md`, `agentic-workflows/BMAD.md` | KEEP; add to the index | Canonical | — |
| `OPENSPEC-FORMAT.md` (303 L) | MERGE → `OPENSPEC-INTEGRATION.md` | Repeats 3 of its sections and the upstream docs | Fix `docs/README.md:60`, `docs/TROUBLESHOOTING.md:380` |
| `pipeline.md` (98 L) | MERGE → `ARCHITECTURE.md` | Same topic | Fix `docs/README.md:71` |
| `AGENT-ADOPTION.md` (249 L) | DELETE | Finished roadmap, in French | `CHANGELOG.md`. Remove `docs/README.md:86` |
| `specs/generation-repair/` (4 files, 782 L) | DELETE | Design notes for a shipped feature | `openspec/specs/mcp-spec-workflow-composites/spec.md`; git history. Remove `docs/README.md:88` |
| `performance-envelope.md` | KEEP; add to the index | `src/doc-claim-sync.test.ts:211`, `scripts/measure-certified-scale.ts:21` | — |
| `contracts.md` | KEEP; add to the index | README links it; the index does not | — |
| `mcp-tools.md` | KEEP; fix lines 255-270 | Names 2 deleted skills | `openlore setup --tools claude`, or the plugin |
| `publishing.md` | KEEP; name `scripts/update-flake.sh` | Maintainer page | — |
| `agents/domain.md`, `agents/issue-tracker.md`, `agents/triage-labels.md` | KEEP | `CLAUDE.md` | — |
| `README.md`, `AGENT-BENCHMARKS.md`, `ALGORITHMS.md`, `ARCHITECTURE.md`, `OPENSPEC-INTEGRATION.md`, `PHILOSOPHY.md`, `REFACTORING-WORKFLOW.md`, `TROUBLESHOOTING.md`, `agent-setup.md`, `api.md`, `architecture-invariants.md`, `change-coupling.md`, `check-weakening.md`, `ci-cd.md`, `cli-reference.md`, `configuration.md`, `coverage-gaps.md`, `cross-domain-impact.md`, `cross-service-topology.md`, `drift-detection.md`, `federation.md`, `generated-files.md`, `governance-dogfooding.md`, `iac.md`, `install.md`, `language-support.md`, `output.md`, `phantom-references.md`, `preflight.md`, `provenance.md`, `providers.md`, `reachability-dead-code.md`, `scip-export.md`, `semantic-search.md`, `session-ledger.md`, `shareable-bundle.md`, `spec-link-index.md`, `spec-tests.md`, `structural-diff.md`, `test-impact-selection.md`, `viewer.md`, `windows-support.md`, 2 image files | KEEP | In the index or pinned by a test | — |

Result: 60 `.md` files → 51 (3 merged away, 6 deleted: `languages.md`, `AGENT-ADOPTION.md`, and 4
under `specs/generation-repair/`).

### CLI commands

All 60 are KEEP. The table in D4 names every command and its group. Nothing is removed or renamed.

## Open questions

1. Delete the two skill copies under `examples/` now (planned), or keep them for one more minor
   release with a deprecation line in the changelog?
2. Four setup commands exist: `install`, `connect`, `setup`, `init`. Should a later change fold
   `setup` into `install`? Other candidates to retire later: the 6 `panic-*` commands and
   `gryph-watch`. Not planned here.
3. The direction says proof comes from daily use. Should a later change delete the one-off
   bench scripts (`bench-reachability.mjs`, `verify-reachability-equivalence.mjs`) and their npm
   scripts? They do not ship, so this change keeps them.
