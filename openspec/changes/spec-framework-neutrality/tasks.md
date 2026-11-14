# Tasks

Each group is one small PR. Groups 1 and 2 are the first shippable slice. This change itself edits
no file under `src/`, `docs/`, `skills/`, `examples/` or `plugin/`; builders do that later. Line
numbers are from main at `0dd75dbef`.

## 1. First run creates no spec folder; a missing CLI is not assessed

- [ ] 1.1 Stop calling `createOpenSpecStructure` at first run: `src/api/init.ts:80-88`,
      `src/cli/commands/init.ts:186-189`. Remove the `'Creating openspec directory'` step and its
      string match in `src/cli/install/index.ts:127-132, 166` (and the hidden
      `--fresh-spec-directory` flag use in `src/cli/commands/analyze.ts:430`; keep the flag parsed).
      Tests: `src/api/init.test.ts`, `src/cli/commands/init.test.ts`,
      `src/cli/install/install.test.ts`, `src/core/services/cold-start-bootstrap.test.ts`.
      Done when: in a temp repo with no spec folder, `init`, `install` and the cold-start path each
      leave no `openspec/` on disk, and a repo that already has `openspec/` is untouched.
- [ ] 1.2 Prove `generate` still creates what it writes (`src/core/generator/openspec-writer.ts:166-168`).
      Test: `src/api/generate.test.ts`. Done when: a test starts with no `openspec/`, runs
      generate with the mock provider, and finds `openspec/specs/` created by the writer.
- [ ] 1.3 `.gitignore`: one line only. `src/core/services/gitignore-manager.ts:63-94`
      (`addToGitignore`, `ensureGitignored`): write exactly `.openlore/`, no comment, no blank
      line; skip when `git check-ignore -q .openlore/` succeeds. Say it once in the first-run
      output (`src/api/init.ts:93`, `src/cli/commands/init.ts:215`). Test:
      `src/core/services/gitignore-manager.test.ts`. Done when: the diff of `.gitignore` after
      first run is 1 added line, a second run adds 0, and an already-ignored repo gets 0.
- [ ] 1.4 Missing `openspec` binary is `not-assessed`. `src/cli/commands/change-status.ts:45-48`
      (`ValidationReceipt` gains `assessed?: false`, `reason?`), `:82-94` (`validateWithOpenSpec`
      maps `ENOENT`/`EACCES`), `:341, :360, :377-382, :404` (verdict, `archivableCandidate`, text).
      Test: `src/cli/commands/change-status.test.ts`. Done when: with `PATH` holding no `openspec`,
      JSON shows `"assessed": false` with the reason, text shows `validates: not assessed (…)`, the
      verdict equals the verdict with a passing validator, and `archivableCandidate` is false.

## 2. Honest answers when there is no spec source

- [ ] 2.1 `orient`: add optional `specSources: { found, lookedFor }` when no source is found.
      `src/core/services/mcp-handlers/orient.ts:214-232, 405-430`. Classify the field in
      `src/core/services/mcp-handlers/confidence-boundary.ts`. Tests:
      `src/core/services/mcp-handlers/orient.test.ts`,
      `src/core/services/mcp-handlers/completeness-invariant.test.ts`. Done when: a repo with no
      spec folder returns `specDomains: []` plus `specSources.found: []`, and a repo with
      `openspec/` returns the same bytes as before.
- [ ] 2.2 Spec tools: replace "run `openlore generate`" with `reason: "no-spec-source"` and
      `lookedFor`. `src/core/services/mcp-handlers/semantic.ts:776, 831, 877`,
      `src/core/services/mcp-handlers/analysis.ts:435`,
      `src/core/generator/spec-link-service.ts:285-286`. Tests:
      `src/core/services/mcp-handlers/semantic.test.ts`,
      `src/core/services/mcp-handlers/analysis.test.ts`. Done when: no response text in these
      handlers contains `openlore generate`, and each names the reason.
- [ ] 2.3 `get_test_coverage`: no scenarios because no spec source → `coveragePercent: null` plus
      the reason, never 0. `src/core/test-generator/coverage-analyzer.ts:370-383`,
      `src/types/test-generator.ts:147`, dispatch at `src/core/services/tool-dispatch.ts:483`.
      Test: `src/core/test-generator/coverage-analyzer.test.ts`. Done when: the no-source fixture
      returns `null` and a corpus with 0 of 4 scenarios covered still returns 0.
- [ ] 2.4 CLI text and exit code. `src/cli/commands/drift.ts:680-683` (keep exit code 2, new
      text), `src/api/drift.ts:76`, `src/cli/commands/doctor.ts:699-716, 1261` (check renamed in
      text to "Spec source", status `ok` when none), `src/cli/commands/analyze.ts:458, 674, 1084`,
      `src/core/analyzer/analysis-indexes.ts:164, 351, 482`. Tests:
      `src/cli/commands/drift.test.ts`, `src/api/drift.test.ts`, `src/cli/commands/doctor.test.ts`,
      `src/cli/commands/analyze.test.ts`. Done when: `openlore drift` in a no-source repo exits 2
      with "no spec source found; spec drift not assessed," and `doctor` shows no warning for it.
- [ ] 2.5 Decision sync and handoff say what they skipped. `src/cli/commands/decisions.ts:575, 649,
      900, 1478` (one line: "no OpenSpec corpus; decision kept in `.openlore/decisions/`"),
      `src/core/services/mcp-handlers/decisions.ts` (`sync_decisions` returns `skipped` with the
      reason), `src/core/services/mcp-handlers/handoff.ts:87-111, 294-303`. Tests:
      `src/cli/commands/decisions-record.test.ts`,
      `src/core/services/mcp-handlers/decisions.test.ts`,
      `src/core/services/mcp-handlers/handoff.test.ts`. Done when: each of the 3 names the skip in
      a no-source repo and none creates a folder.

## 3. Config

- [ ] 3.1 `openspecPath` optional. `src/types/index.ts:22, 426`,
      `src/core/services/config-schema.ts:333` (remove from `required`),
      `src/core/services/config-manager.ts:115-119, 146-149, 283` (no backfill when no OpenSpec
      corpus exists), `src/pi/extension.ts:104, 609`. Tests:
      `src/core/services/config-schema.test.ts`, `src/core/services/config-manager.test.ts`,
      `src/pi/extension.test.ts`. Done when: a config without the key validates with 0 findings, a
      config with it reads as before, and `tsc` passes with every reader handling `undefined`.
- [ ] 3.2 New optional key `adrPaths: string[]` (read-only ADR folders, confined to the repo).
      `src/types/index.ts`, `src/core/services/config-schema.ts:302-331, 346`. Tests:
      `src/core/services/config-schema.test.ts`. Done when: a wrong type and a path outside the
      repo each give a named finding, and the key is listed in `docs/configuration.md` (task 11.4).

## 4. The interface, with OpenSpec behind it (no behavior change)

- [ ] 4.1 Add `src/core/spec-sources/types.ts` (new) and `src/core/spec-sources/index.ts` (new):
      `SpecSource`, `SpecItem`, `detectSpecSources`, `listSpecItems`, the fixed order. Test:
      `src/core/spec-sources/index.test.ts` (new). Done when: with zero adapters registered it
      returns `found: []` and the 6 ids in `lookedFor`.
- [ ] 4.2 OpenSpec adapter `src/core/spec-sources/openspec.ts` (new) wrapping `loadSpecCorpus`
      (`src/core/generator/spec-link-service.ts:116`) and one shared heading parser. Point
      `buildSpecMap` (`src/core/drift/spec-mapper.ts:299-330`) and `detectExistingSpecDir`
      (`src/core/services/config-manager.ts:403-424`) at it. Tests:
      `src/core/spec-sources/openspec.test.ts` (new), `src/core/drift/spec-mapper.test.ts`,
      `src/core/services/config-manager.test.ts`. Done when: on this repo's own corpus, `SpecMap`
      and `loadSpecCorpus` output are byte-equal before and after, and a bare `specs/001-x/spec.md`
      with no `### Requirement:` is no longer detected as OpenSpec.
- [ ] 4.3 Move the other listers to the adapter, one commit per file: the sites in
      `C-neutrality` table 1c that list `<root>/specs/<domain>/spec.md`
      (`src/core/analyzer/analysis-indexes.ts:161-172`, `src/core/analyzer/spec-vector-index.ts:1155`,
      `src/core/digest/digest-generator.ts:167`, `src/core/services/mcp-handlers/semantic.ts:767-773,
      823-843`, `src/core/services/mcp-handlers/orient.ts:219-227`, `src/cli/commands/doctor.ts:702-710`).
      Tests: the existing test beside each file. Done when: the full unit suite passes with no
      snapshot change, and `grep -n "readdir" ` in those ranges finds no direct spec listing.

## 5. Hard-coded `openspec` sites honor `openspecPath`

- [ ] 5.1 Handlers: `src/core/services/mcp-handlers/orient.ts:278, 566`,
      `blast-radius.ts:453`, `semantic.ts:927, 1005`, `change.ts:290, 343, 351`,
      `working-set.ts:341, 449`. Tests: the `.test.ts` beside each. Done when: a fixture with
      `openspecPath: "docs"` serves `docs/specs/<domain>/spec.md` paths from all 5 handlers.
- [ ] 5.2 CLI and Pi: `src/cli/commands/change-status.ts:97, 241-301`, `test.ts:154`,
      `analyze.ts:1163`, `digest.ts:66`, `import.ts:610, 613`, `doctor.ts:428`,
      `refresh-stories.ts:309`, `src/cli/manifest/emit.ts:147`, `src/pi/extension.ts:1260, 3004`.
      Tests: `src/cli/commands/change-status.test.ts`, `src/cli/commands/analyze.test.ts`,
      `src/cli/commands/doctor.test.ts`, `src/pi/extension.test.ts`. Done when: the same `docs`
      fixture gives the same results as the default layout for each command.
- [ ] 5.3 Core: `src/core/analyzer/codebase-digest.ts:302-316`,
      `src/core/test-generator/scenario-parser.ts:233`, `src/core/drift/corpus-intent-review.ts:79`,
      `src/core/drift/git-diff.ts:268, 459`, `src/core/decisions/extractor.ts:92`,
      `src/core/verifier/verification-engine.ts:1249`, `src/core/analyzer/artifact-generator.ts:982`,
      `src/core/generator/adr-generator.ts:181`. Tests: the `.test.ts` beside each. Done when:
      `grep -rn "'openspec/\|\"openspec/\|\`openspec/" src --include="*.ts"` outside tests, the
      OpenSpec adapter, the generator and `src/constants.ts` returns 0 lines.

## 6. Adapter: ADR folders

- [ ] 6.1 `src/core/spec-sources/adr.ts` (new): read `docs/adr`, `docs/decisions` and `adrPaths`;
      MADR and Nygard shapes give title, status and decision text with `file` and `line`; other
      shapes give the title only. Register in `src/core/spec-sources/index.ts`. Test:
      `src/core/spec-sources/adr.test.ts` (new). Done when: one fixture per shape lists `decision`
      items, and no file is written (assert the fixture tree hash is unchanged).
- [ ] 6.2 Surface them: `orient` and `search_specs` return ADR items; `verify_claim`
      `decision-governed` lists a matching ADR as "found in ADR folder, not anchored" (never as
      governing). `src/core/services/mcp-handlers/orient.ts`, `semantic.ts`,
      `claim-verification.ts`. Tests: the `.test.ts` beside each, plus the parity guard
      `src/pi/extension.test.ts:1330-1365`. Done when: a repo with only `docs/adr` gets ADR items
      in `orient` and `search_specs`, and `specSources.found` is `["adr"]`.

## 7. Adapters: markdown requirements, then tests as intent

- [ ] 7.1 `src/core/spec-sources/markdown-requirements.ts` (new): tracked `*.md` outside other
      sources; list sentences with upper-case SHALL / MUST / SHOULD or the EARS shape "WHEN … THE
      … SHALL"; a file counts only with 3 or more matches. Test:
      `src/core/spec-sources/markdown-requirements.test.ts` (new). Done when: an EARS fixture and
      an RFC 2119 fixture list every sentence with its line, and a README with "you must" in
      lower case lists 0.
- [ ] 7.2 `src/core/spec-sources/tests.ts` (new): for files where `isTestFile`
      (`src/core/analyzer/test-file.ts:97`) is true, list `describe` / `it` / `test` titles
      (TypeScript, JavaScript), `def test_*` (Python), `func Test*` (Go) as `test-intent`. Other
      languages: not assessed, named in `lookedFor`. Test: `src/core/spec-sources/tests.test.ts`
      (new). Done when: one fixture per language lists titles with lines, and `tests` alone never
      makes `specSources.found` non-empty for a requirement answer (design decision 3).

## 8. Adapter: Kiro

- [ ] 8.1 Confirm the layout against a real Kiro project and write the result at the top of
      `src/core/spec-sources/kiro.ts` (new): assumed `.kiro/specs/<feature>/requirements.md`,
      `design.md`, `tasks.md`. Done when: the comment names the project checked and the date.
- [ ] 8.2 Implement: numbered requirements and EARS acceptance criteria as `requirement`, task
      checkboxes as `task`. Test: `src/core/spec-sources/kiro.test.ts` (new). Done when: the
      fixture lists every acceptance criterion with its line and nothing is written.

## 9. Adapter: Spec Kit

- [ ] 9.1 Confirm the layout against the current Spec Kit templates and write the result at the
      top of `src/core/spec-sources/spec-kit.ts` (new): assumed marker `.specify/`, features in
      `specs/<NNN-feature>/spec.md`, `plan.md`, `tasks.md`; requirements as `FR-NNN`, acceptance
      scenarios as Given/When/Then. Done when: the comment names the version checked.
- [ ] 9.2 Implement; `FR-NNN` lines as `requirement`, acceptance scenarios as `scenario`,
      `tasks.md` checkboxes as `task`. Test: `src/core/spec-sources/spec-kit.test.ts` (new). Done
      when: a fixture with `.specify/` and `specs/001-x/spec.md` is detected as `spec-kit`, not
      `openspec`, and a repo with both `openspec/` and `.specify/` reports both.

## 10. Text: tool descriptions and the prompt hint

- [ ] 10.1 Reword tool descriptions in `src/cli/commands/mcp.ts`: `prepare_spec_generation` `:265`,
      `prepare_spec_repair` `:281`, `get_mapping` `:478-483` (drop the stale "llm / heuristic" and
      "Requires openlore generate"), `check_spec_drift` `:504-511`, `list_spec_domains` `:1038`,
      `search_specs` `:1049-1055`, `get_spec` `:1170-1175`, `generate_change_proposal` `:1252-1254`,
      `generate_tests` `:1464`, `get_test_coverage` `:1505`, `get_handoff_briefing` `:2005`,
      `sync_decisions` `:2392`. Names and schemas do not change. Tests:
      `src/core/services/mcp-handlers/tool-contract.test.ts`, `src/doc-claim-sync.test.ts`,
      `src/pi/extension.test.ts`. Done when: each description says what happens with no spec
      source or says "OpenSpec-format" where it writes that format, and the 3 guards pass.
- [ ] 10.2 Prompt hint for any authoring workflow. `src/cli/commands/proposal-context.ts:23-36`:
      also match `/speckit.specify`, `/speckit.plan`, `/kiro` spec commands, and the loose match
      with "spec" in place of the word "openspec". Keep the exported names. Callers:
      `src/cli/commands/orient-inject.ts:96`, `src/pi/extension.ts:3020`,
      `src/cli/install/adapters/codex.ts:10-15, 272`. Tests:
      `src/cli/commands/proposal-context.test.ts`, `src/cli/install/adapters/codex.test.ts`. Done
      when: the 4 old triggers still match, the new ones match, and "write a spec for the parser
      fix" with no proposal verb does not.

## 11. Text: install, skills, docs, examples

- [ ] 11.1 Install and first-run text: `src/cli/install/index.ts:814-827` (uninstall note),
      `src/cli/commands/orient.ts:115, 284`, `src/core/analyzer/codebase-digest.ts:312-316`
      ("Spec domains" heading). Tests: `src/cli/install/install.test.ts`,
      `src/core/analyzer/codebase-digest.test.ts`. Done when: no install or digest text says a
      spec folder was created, and the digest section is omitted when no source is found.
- [ ] 11.2 Skills: make the OpenSpec steps conditional ("if the repo has an OpenSpec corpus") in
      `skills/claude-openlore.md`, `skills/story-to-change.md`, `skills/openlore-generate/SKILL.md`,
      `skills/openlore-repair/SKILL.md`, `skills/openlore-brainstorm/SKILL.md`,
      `skills/openlore-implement-story/SKILL.md`, `skills/openlore-implement-feature.md`,
      `skills/openlore-write-tests/SKILL.md`. `skills/openspec-skill.md` stays OpenSpec by design.
      Test: `src/cli/install/skill-wrapper.test.ts`. Done when: no skill stops or fails its
      instructions when `openspec/` is absent.
- [ ] 11.3 Examples: `examples/spec-kit/commands/orient.md:59`, `drift.md:36`, `README.md:88`,
      `extension.yml:41` read Spec Kit specs through OpenLore, not `ls openspec/specs/`. Same
      pattern in `examples/gsd/`, `examples/bmad/`, `examples/opencode/plugins/`. No test; done
      when: `grep -rn "ls .*openspec/specs" examples` returns 0 lines outside
      `examples/openspec-cli/` and `examples/openspec-analysis/`.
- [ ] 11.4 Docs: one new page `docs/spec-sources.md` (new) with the detection table and the
      limits; update `docs/configuration.md` (`openspecPath` optional, `adrPaths`),
      `docs/install.md` (no folder at first run, the one `.gitignore` line), `docs/mcp-tools.md`,
      `docs/drift-detection.md`, `docs/TROUBLESHOOTING.md:196`, `docs/agents/domain.md:14`,
      `README.md`. `docs/OPENSPEC-INTEGRATION.md` and `docs/OPENSPEC-FORMAT.md` stay. If `plugin/`
      has landed (PR #727), check its README text only. Test: `src/doc-claim-sync.test.ts`. Done
      when: the guard passes and no doc says OpenSpec or `openlore generate` is required.
