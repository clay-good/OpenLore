# Tasks

Each group is one small PR. Build them in order. Do not start before PR #727
(`ship-claude-code-plugin`) is merged: until then `plugin/`, `README.md`, `docs/`, `scripts/` and
`src/` belong to the plugin session. Every removal gets a line under "Removed" in `CHANGELOG.md`
(`## [Unreleased]`) that names the replacement.

## 1. Loose skill files (PR 1)

- [ ] 1.1 Merge `skills/spec-workflow-protocol.md` into `skills/openlore-generate/SKILL.md` and
      `skills/openlore-repair/SKILL.md`: add any of its 7 bullets that a skill does not state yet,
      then delete the loose file. Reason: 0 references; the two skills are its only readers.
      Test: `src/core/services/spec-workflow-skills.test.ts`. Done when the existing generate and
      repair assertions pass and the loose file is gone.
- [ ] 1.2 Delete `skills/claude-openlore.md` and `skills/openspec-skill.md`. Reason: superseded by
      `openlore-generate` and by OpenSpec's own tooling. In the same commit replace
      `docs/mcp-tools.md:255-270` with "run `openlore setup --tools claude`, or install the plugin"
      and fix `AGENTS.md:241`. Test: `src/cli/commands/docs-index.test.ts`. Done when
      `grep -rn "claude-openlore.md\|openspec-skill.md" docs AGENTS.md README.md src` prints nothing.
- [ ] 1.3 Delete `skills/openlore-analyze-codebase.md`, `skills/openlore-execute-refactor.md` and
      `skills/openlore-plan-refactor.md`. Reason: older forms of folder skills with the same name;
      Pi offers both. Replacement: the folder skill. Test:
      `src/core/services/spec-workflow-skills.test.ts`. Done when `openlore setup` installs the
      same 10 skills (`toHaveLength(10)` still passes).
- [ ] 1.4 Delete `skills/openlore-implement-feature.md` and `skills/story-to-change.md`. Reason:
      no installer reads them. Replacement: `openlore-implement-story` (Pi, Claude Code),
      `examples/cline-workflows/openlore-implement-feature.md` (Cline, unchanged), and
      `openlore-brainstorm` for stories. Test: `src/core/services/spec-workflow-skills.test.ts`.
      Done when `src/cli/commands/setup.ts:169` still resolves its Cline source file.
- [ ] 1.5 Add a guard to `src/core/services/spec-workflow-skills.test.ts`: every entry at the root
      of `skills/` (except `.DS_Store`) is a directory that holds `SKILL.md`. Done when the test
      fails after `touch skills/x.md` and passes without it.

## 2. Docs (PR 2)

- [ ] 2.1 Delete `docs/languages.md`. Reason: a 4-line redirect with 0 inbound links.
      Replacement: `docs/language-support.md`. Change the test at
      `src/cli/commands/docs-index.test.ts:65-70` to assert that the file is absent and that no
      doc links it. Done when that test passes.
- [ ] 2.2 Merge `docs/agentic-workflows.md` into `docs/agentic-workflows/README.md`, then delete
      it. Fix `docs/README.md:80`; add `agentic-workflows/BMAD.md` to the index; replace
      `docs/agent-setup.md:239-251` with one link line; point
      `src/core/services/feature-inventory.ts:168` at `docs/install.md`. Reason: two pages, one
      table. Test: `src/core/services/feature-inventory.test.ts`. Done when
      `grep -rn "agentic-workflows.md" docs src README.md` prints nothing.
- [ ] 2.3 Merge `docs/OPENSPEC-FORMAT.md` into `docs/OPENSPEC-INTEGRATION.md`: move only text
      that the target and the upstream OpenSpec docs do not have, then delete it. Fix
      `docs/README.md:60` and `docs/TROUBLESHOOTING.md:380`. Reason: it repeats 3 sections.
      Test: `src/cli/commands/docs-index.test.ts`. Done when `grep -rn "OPENSPEC-FORMAT" docs
      README.md src` prints nothing.
- [ ] 2.4 Merge `docs/pipeline.md` into `docs/ARCHITECTURE.md`, then delete it. Fix
      `docs/README.md:71`. Reason: same topic. Test: `src/cli/commands/docs-index.test.ts`. Done
      when `grep -rn "pipeline.md" docs README.md src` prints nothing.
- [ ] 2.5 Delete `docs/AGENT-ADOPTION.md` and the 4 files in `docs/specs/generation-repair/`.
      Remove `docs/README.md:86` and `:88`. Reason: a finished roadmap and design notes for a
      shipped feature. Replacement: `CHANGELOG.md` and
      `openspec/specs/mcp-spec-workflow-composites/spec.md`. Test:
      `src/cli/commands/docs-index.test.ts`. Done when `ls docs/specs` fails.
- [ ] 2.6 Add `contracts.md` and `performance-envelope.md` to `docs/README.md`, and name
      `scripts/update-flake.sh` in `docs/publishing.md`. Reason: 2 pages and 1 script that nothing
      links. Test: `src/cli/commands/docs-index.test.ts`: assert that every `docs/*.md` file is
      linked from `docs/README.md` or `README.md` (`docs/agents/` excepted). Done when it passes.
- [ ] 2.7 Add a link check to `src/cli/commands/docs-index.test.ts`: every relative Markdown link
      in `README.md`, `AGENTS.md`, `CHANGELOG.md` (`## [Unreleased]` only), `docs/**/*.md`,
      `examples/**/README.md` and `skills/**/*.md`, and every `docs: '<path>'` string in
      `src/core/services/feature-inventory.ts`, names a file that exists. No network; `#anchor`
      parts are ignored. Done when the test fails on a made-up link and passes on the tree.

## 3. Examples and the package (PR 3)

- [ ] 3.1 Delete `examples/drift-demo/` (21.3 KB), `examples/drift-test/` (33.9 KB),
      `examples/openspec-analysis/` (491.7 KB) and `examples/openspec-cli/` (30.1 KB). Reason: 0
      references; `openspec-analysis` holds absolute paths of a developer machine. Replacement:
      run `openlore analyze`, `openlore generate` or `openlore drift`. Test: `npm run
      audit:packlist`. Done when it passes and `npm pack --dry-run` lists none of the 4 folders.
- [ ] 3.2 Delete the 9 skill folders in `examples/opencode-skills/` and in
      `examples/mistral-vibe/skills/`. Write `examples/opencode-skills/README.md` (new) and
      `examples/mistral-vibe/skills/README.md` (new), 3 lines each: the skills are at
      `skills/<name>/SKILL.md`; `openlore setup` installs them. In the same commit change the test
      at `src/core/services/spec-workflow-skills.test.ts:157-163` to assert that neither folder
      holds a `SKILL.md`, and remove lines 60-61 from `REQUIRED` in `scripts/audit-packlist.mjs`.
      Add one line to `docs/agent-setup.md` that names both former paths and the new one.
      Reason: byte-identical copies. Done when the test and `npm run audit:packlist` pass.
- [ ] 3.3 Set `files` in `package.json` to the list in `design.md` (9 example folders by name,
      `!examples/**/*.test.*`). In `scripts/audit-packlist.mjs` add a check: each `examples/<dir>`
      in the pack list is named in `src/cli/commands/setup.ts` or in a file under `docs/`. Test:
      `npm run audit:packlist`. Done when it fails after `mkdir examples/x && touch examples/x/a`
      plus a `files` entry, and `npm pack --dry-run` reports about 775 KB less unpacked size than
      3.6.0.
- [ ] 3.4 Confirm that Windows CI still runs the example tests: `.github/workflows/ci.yml:267`
      (`vitest run src examples`). No edit is expected. Done when
      `npx vitest run examples` runs the 2 files in `examples/opencode/plugins/`.

## 4. CLI help (PR 4)

- [ ] 4.1 In `src/cli/help-groups.ts` add `status` to "Set up & run", `handoff` to "Govern a
      change" and `mapping` to "Inspect & author specs"; remove `check-edit`, `panic-check` and
      `panic-level` from their groups; export `HIDDEN_PLUMBING_COMMANDS` (`hook`, `statusline`,
      `check-edit`, `panic-check`, `panic-level`). Test: `src/cli/help-groups.test.ts`. Done when
      the group table in `design.md` D4 matches `COMMAND_GROUPS`.
- [ ] 4.2 In `src/cli/index.ts:226-285` register those 5 with
      `program.addCommand(cmd, { hidden: true })`. Test: `src/cli/help-groups.test.ts` (new
      cases): `--help` output has none of the 5 names as a command row; each of the 5 still parses
      and answers `<name> --help`. Done when both cases pass and `openlore hook before-edit`
      behaves as before (`src/cli/commands/hook.test.ts` passes).
- [ ] 4.3 Add a guard to `src/cli/help-groups.test.ts` that imports the real program: every
      registered command is in `COMMAND_GROUPS` or in `HIDDEN_PLUMBING_COMMANDS`, and never both.
      Done when the "Other" group holds only `help` and a new ungrouped command fails the test.
- [ ] 4.4 Remove the number from the stale comments: `src/cli/index.ts:287`,
      `src/cli/help-groups.ts:5` and the comment in `src/cli/index-help.test.ts` ("~49"). Add a
      "Harness plumbing" heading for the 5 commands in `docs/cli-reference.md`. Test:
      `src/cli/commands/mcp-tool-count-doc.test.ts`. Done when `grep -rn "~49" src/cli` prints
      nothing.

## 5. README (PR 5)

- [ ] 5.1 Move "Value Scorecard" to `docs/AGENT-BENCHMARKS.md` and "OpenLore vs. alternatives" and
      "Is OpenLore for you?" to `docs/PHILOSOPHY.md`. Point `src/honesty-contract.test.ts:41-47` at
      the new file in the same commit. Done when the figures are guarded where they now live.
- [ ] 5.2 Rewrite `README.md` to the 7 sections in `design.md` D5, 120 lines or fewer. Section 3
      lists the plugin default tools from `reframe-governance-as-agent-evidence`; it does not
      define them. Tests: `src/doc-claim-sync.test.ts`,
      `src/cli/commands/mcp-tool-count-doc.test.ts`, `src/cli/commands/docs-index.test.ts`. Add a
      case to `src/doc-claim-sync.test.ts`: `README.md` has at most 120 lines. Done when all pass.

## 6. Plugin skill list (PR 6)

- [ ] 6.1 None: `adopt-agent-context-interop` task 3.3 guards `plugin/skills/`.
- [ ] 6.2 Run `openspec validate curate-product-surface`, `npm run audit:packlist` and
      `npx vitest run src/core/services/spec-workflow-skills.test.ts src/cli/help-groups.test.ts
      src/cli/commands/docs-index.test.ts src/doc-claim-sync.test.ts src/honesty-contract.test.ts
      src/pi/extension.test.ts`. Done when all pass (the Pi parity guard is unchanged: no tool
      output shape changes).
