# Design: curate-product-surface

Facts were measured on 2026-11-14 at main 0dd75dbef. Sizes are bytes on disk, unpacked.

## Decisions

### D1. Four outcomes, and one test for "referenced"

- **Decision.** Each item gets SHIP IN PLUGIN, KEEP, MERGE or DELETE. An item is "referenced" when
  a tracked file under `src/`, `scripts/`, `docs/`, `.github/`, or one of `package.json`,
  `README.md`, `AGENTS.md`, `CLAUDE.md` names its path. A file that ships in the npm package must
  be referenced. **Why:** a grep gives a builder and a reviewer the same answer. **Rejected:**
  "delete what looks old" (no test can defend it).

### D2. `skills/<name>/SKILL.md` is the only source copy of a skill

- **Decision.** Loose `.md` files at the root of `skills/` are deleted. The two copies under
  `examples/` are deleted, and each folder keeps a 3-line `README.md` that names the new path.
  `plugin/skills/` is a build copy; its byte-identity test belongs to `adopt-agent-context-interop`.
- **Why.** Pi loads the whole folder (`package.json` `pi.skills`), so every loose file is offered
  to the agent; `openlore setup` reads only `skills/<name>/SKILL.md` (`setup.ts:163`); the copies
  exist only for a test (`spec-workflow-skills.test.ts:157-163`) and a pack check
  (`audit-packlist.mjs:60-61`). **Rejected:** keep the copies one more release (byte-identical since
  2026-08-30, nothing in the package reads them; open question 1).

### D3. The plugin ships 5 skill folders, one per loop job

| Job in the agent loop | Skill folder | Lines today | Plugin | `openlore setup` | Pi |
|---|---|---|---|---|---|
| Orient before reading | `openlore-orient` | 72 | yes | no (as today) | yes |
| Implement / debug / review / test | `openlore-implement-story` (258), `openlore-debug` (289), `openlore-review-changes` (132), `openlore-write-tests` | — | yes | yes | yes |
| Spec generate / repair | `openlore-generate` (16), `openlore-repair` (17) | 33 | no | yes | yes |
| Other workflows | `openlore-analyze-codebase`, `openlore-brainstorm`, `openlore-plan-refactor`, `openlore-execute-refactor` | — | no | yes | yes |

- **Why.** These 5 jobs are the inner loop. The spec pair calls `prepare_spec_generation` /
  `prepare_spec_repair`, which are OpenSpec-format and not in the `plugin` preset
  (`reframe-governance-as-agent-evidence`), so it stays out. The other 4 are longer workflows a user
  starts on purpose. **Rejected:** all 11 (11 descriptions every session); the spec pair (two
  OpenSpec-only tools); `openlore-plan-refactor` in place of implement (no implement recipe).
- **Note.** `openlore-implement-story` and `openlore-debug` name tools outside the `plugin` preset today
  (`search_specs`, `check_spec_drift`, `audit_spec_coverage`); `adopt-agent-context-interop` cuts them.

### D4. Hide harness plumbing with Commander's `hidden` option

- **Decision.** Register `hook`, `statusline`, `check-edit`, `panic-check` and `panic-level` with
  `program.addCommand(cmd, { hidden: true })` in `src/cli/index.ts:226-285`. Name them in a new
  `HIDDEN_PLUMBING_COMMANDS` list in `src/cli/help-groups.ts`. Group titles do not change.
- **Why.** Hooks or the status line run these 5. Hidden commands still run and answer
  `openlore <name> --help`; `docs/cli-reference.md` keeps them. **Rejected:** remove or rename them
  (hook commands in user settings would break); new group titles (churn in `help-groups.test.ts`).
- **Spec note.** An `OptionalFeatureDependenciesDegradeAtTheirOwnCommand` scenario says `--help` "lists
  every command" (SHALL: "list its commands"); reword it at archive if the owner wants.

Help groups after the change (55 shown, 5 hidden, 60 registered; all 60 KEEP, none removed or renamed):

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

Sections, with line budget and source today: 0 title, claim, badges (10; lines 1-35); 1 install:
plugin, npm, Pi (20; "Install once, then forget it"); 2 the 4 moments (20; "What you get"); 3
default pull tools (15; "What your agent reaches for"); 4 limits and cost (15; "Known limitations"
+ "What it costs"); 5 languages (5; link); 6 documentation (15); 7 development and community (15;
"Development" + "Community" + "Links").

- Moved out: "Value Scorecard" → `docs/AGENT-BENCHMARKS.md` (1 link line stays). "OpenLore vs.
  alternatives" and "Is OpenLore for you?" → `docs/PHILOSOPHY.md`. **Why:** proof comes from daily
  use; the front page says what installs, what runs, and the limits.
- **Guards that read README today** must pass or move in the same task: `honesty-contract.test.ts:43-47`
  (scorecard), `doc-claim-sync.test.ts:95` (badge), `mcp-tool-count-doc.test.ts:58,78`, `docs-index.test.ts`.
  **Rejected:** delete the scorecard (its figures are guarded; `skills/openlore-orient` cites them).

### D6. Docs: the file with more inbound links or the later commit wins

Unique text moves into the winner; the other file is deleted; inbound links are fixed in the task.

## Inventory

### `skills/` (19 entries; 8 files, 43,837 bytes removed)

| Item | Outcome | Reason | Replacement / who could rely on it |
|---|---|---|---|
| `openlore-orient/`, `openlore-implement-story/`, `openlore-debug/`, `openlore-review-changes/`, `openlore-write-tests/` | SHIP IN PLUGIN + KEEP (setup, Pi) | The 5 loop jobs (D3); `openlore-write-tests` also named by `src/cli/commands/test.ts` and 2 docs | — |
| `openlore-generate/`, `openlore-repair/`, `openlore-analyze-codebase/`, `openlore-brainstorm/` | KEEP (setup, Pi) | Installed by `setup`; the first 2 are the outer loop (write and repair specs) | — |
| `openlore-plan-refactor/`, `openlore-execute-refactor/` | KEEP | `docs/REFACTORING-WORKFLOW.md` | — |
| `openlore-analyze-codebase.md` (4,301 b), `openlore-execute-refactor.md` (8,193 b), `openlore-plan-refactor.md` (8,238 b) | DELETE | Old form of the folder skill | Folder skill. Pi users only |
| `openlore-implement-feature.md` (6,707 b) | DELETE | No installer reads it | Pi: `openlore-implement-story`. Cline: `examples/cline-workflows/openlore-implement-feature.md` (still installed by `setup`) |
| `claude-openlore.md` (6,281 b); `openspec-skill.md` (6,430 b) | DELETE | Superseded by `openlore-generate`; OpenSpec owns its authoring skill | `openlore-generate`; OpenSpec's own tooling and `search_specs`. Links at `docs/mcp-tools.md:259-260` and `AGENTS.md:241` fixed in task 1.2 |
| `story-to-change.md` (2,904 b) | DELETE | 0 references | `openlore-brainstorm` writes the story; the spec framework proposes the change |
| `spec-workflow-protocol.md` (783 b) | MERGE → `openlore-generate`, `openlore-repair` | 0 references; 7 bullets | The 2 skills state the same rules |

### `examples/` (13 folders, 907 KB today)

| Item (size) | Outcome | Reason | Replacement / who could rely on it |
|---|---|---|---|
| `bmad/` (36.8 KB), `cline-workflows/` (43.1 KB), `gsd/` (13.1 KB) | KEEP | `setup.ts` installs them | — |
| `opencode/` (65.3 KB) | KEEP; 2 test files leave the package (12.8 KB) | `setup.ts` installs the plugin; the tests run in CI (`ci.yml:267`) | Tests stay in the repository |
| `ci/` (2.0 KB), `pi/` (9.8 KB), `spec-kit/` (12.4 KB), `mistral-vibe/` README + template (5.9 KB) | KEEP | Named by docs (`ci/` also by `preflight.test.ts`); `spec-kit/` shows a second spec framework | — |
| `mistral-vibe/skills/`, `opencode-skills/` (70.9 KB each) | DELETE, leave a `README.md` stub | Byte-identical copies | `skills/<name>/SKILL.md` or `openlore setup --tools vibe` / `--tools opencode`. Scripts that read the old path |
| `drift-demo/` (21.3 KB), `drift-test/` (33.9 KB), `openspec-analysis/` (491.7 KB), `openspec-cli/` (30.1 KB) | DELETE | 0 references; `openspec-analysis/` holds absolute paths of a developer machine | `docs/drift-detection.md`, `openlore drift`, `openlore analyze`, `openlore generate` on your own repository |

Leaves the package: 577.0 + 141.8 + 12.8 = 731.6 KB from `examples/`, plus 43.8 KB of loose
skills: about 775 KB. `examples/` in the package goes from 907 KB to about 176 KB.
`package.json` `files` afterwards: `"dist", "!dist/**/*.test.*", "scripts/postinstall.mjs",
"src/viewer", "!src/viewer/**/*.test.*", "examples/bmad", "examples/ci", "examples/cline-workflows",
"examples/gsd", "examples/mistral-vibe", "examples/opencode", "examples/opencode-skills",
"examples/pi", "examples/spec-kit", "!examples/**/*.test.*", "skills", "!skills/.DS_Store", "stubs",
"schemas", "README.md", "LICENSE"`.

### `stubs/` and `scripts/`

No script is deleted. Only `postinstall.mjs` ships (the `postinstall` script), so no user sees the
others. All KEEP: `stubs/tree-sitter-cli-stub/` (`package.json` `overrides`); the build, CI and
`prepublishOnly` scripts (`copy-assets`, `audit-gate`, `audit-packlist`, `audit-dependencies` +
`.d.mts`, `backfill-lock-integrity`, `api-consumer-smoke`, `optional-absence-register`,
`optional-absence-hook`, `windows-unit-report`); `diagnose-windows-daemon.ps1`
(`docs/windows-support.md`); `update-homebrew-formula.mjs` (release step); `install-skill.js`
(`skill:install-local`, the only installer of `openlore-orient` outside the plugin); `bench.ts`,
`bench-mcp.ts`, `bench-watch.ts`, `bench-agent.ts`, `bench-agent.tasks.ts`, `BENCHMARKS.md`,
`bench-preset-{surface,selection,completion}.ts`, `bench-reachability.mjs`,
`verify-reachability-equivalence.mjs`, `measure-certified-scale.ts` (not shipped; tests and docs
name 4; open question 3). `update-flake.sh` keeps `flake.nix` in step but no file names it: add a
reference in `docs/publishing.md`.

### `docs/` (60 `.md` files → 51: 3 merged away; 6 deleted, `languages.md`, `AGENT-ADOPTION.md`, 4 under `specs/generation-repair/`)

| Item | Outcome | Reason | Replacement and link fixes |
|---|---|---|---|
| `languages.md` (4 L); `AGENT-ADOPTION.md` (249 L); `specs/generation-repair/` (4 files, 782 L) | DELETE | Redirect stub with 0 inbound links; finished roadmap, in French; design notes for a shipped feature | `language-support.md` (update `docs-index.test.ts:65-70`); `CHANGELOG.md`; `openspec/specs/mcp-spec-workflow-composites/spec.md`. Remove `docs/README.md:86, 88` |
| `agentic-workflows.md` (14 L) | MERGE → `agentic-workflows/README.md` | Same table; 4 example READMEs link the folder | Fix `docs/README.md:80`, `src/core/services/feature-inventory.ts:168` (→ `docs/install.md`), `docs/agent-setup.md:239-251` (→ 1 link line) |
| `OPENSPEC-FORMAT.md` (303 L) | MERGE → `OPENSPEC-INTEGRATION.md` | Repeats 3 of its sections and the upstream docs | Fix `docs/README.md:60`, `docs/TROUBLESHOOTING.md:380` |
| `pipeline.md` (98 L) | MERGE → `ARCHITECTURE.md` | Same topic | Fix `docs/README.md:71` |
| `agentic-workflows/README.md`, `agentic-workflows/BMAD.md`, `performance-envelope.md` (`doc-claim-sync.test.ts:211`, `measure-certified-scale.ts:21`), `contracts.md` (README links it) | KEEP; add to the index | Canonical or linked, not in the index | — |
| `mcp-tools.md`; `publishing.md` | KEEP; fix lines 255-270; name `scripts/update-flake.sh` | Names 2 deleted skills; maintainer page | `openlore setup --tools claude`, or the plugin |
| `agents/domain.md`, `agents/issue-tracker.md`, `agents/triage-labels.md` (`CLAUDE.md`); `README.md`, `AGENT-BENCHMARKS.md`, `ALGORITHMS.md`, `ARCHITECTURE.md`, `OPENSPEC-INTEGRATION.md`, `PHILOSOPHY.md`, `REFACTORING-WORKFLOW.md`, `TROUBLESHOOTING.md`, `agent-setup.md`, `api.md`, `architecture-invariants.md`, `change-coupling.md`, `check-weakening.md`, `ci-cd.md`, `cli-reference.md`, `configuration.md`, `coverage-gaps.md`, `cross-domain-impact.md`, `cross-service-topology.md`, `drift-detection.md`, `federation.md`, `generated-files.md`, `governance-dogfooding.md`, `iac.md`, `install.md`, `language-support.md`, `output.md`, `phantom-references.md`, `preflight.md`, `provenance.md`, `providers.md`, `reachability-dead-code.md`, `scip-export.md`, `semantic-search.md`, `session-ledger.md`, `shareable-bundle.md`, `spec-link-index.md`, `spec-tests.md`, `structural-diff.md`, `test-impact-selection.md`, `viewer.md`, `windows-support.md`, 2 image files | KEEP | In the index or pinned by a test | — |

## Open questions

1. Delete the two skill copies under `examples/` now (planned), or one minor release later with a changelog note?
2. Should a later change fold `setup` into `install` (4 setup commands exist: `install`, `connect`, `setup`,
   `init`) and retire the 6 `panic-*` commands and `gryph-watch`?
3. Delete the one-off `bench-reachability.mjs`, `verify-reachability-equivalence.mjs` and their npm scripts later? Kept here.
