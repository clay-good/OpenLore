# Tasks

One small PR per group; groups 1-2 are the first slice. This change edits only its own folder;
builders edit `src/`, `docs/`, `skills/`, `examples/`, `plugin/` later. Lines are from main at
`0dd75dbef`. "Beside" = the existing `.test.ts` next to each named file.

## 1. First run creates no spec folder; a missing CLI is not assessed

- [ ] 1.1 No `createOpenSpecStructure` at first run (`src/api/init.ts:80-88`, `cli/commands/init.ts:186-189`);
  drop the `'Creating openspec directory'` step and match (`install/index.ts:127-132, 166`) and the
  `--fresh-spec-directory` use (`analyze.ts:430`; flag stays parsed). Tests: both `init.test.ts`,
  `install.test.ts`, `cold-start-bootstrap.test.ts`. Done when: no new `openspec/`; an existing one is untouched.
- [ ] 1.2 `generate` creates what it writes (`openspec-writer.ts:166-168`). Test: `src/api/generate.test.ts`.
  Done when: with no `openspec/`, mock-provider generate creates `openspec/specs/`.
- [ ] 1.3 `.gitignore`: `addToGitignore` / `ensureGitignored` (`gitignore-manager.ts:63-94`) write
  exactly `.openlore/` (no comment, no blank line) and skip when `git check-ignore -q .openlore/`
  succeeds; first-run output says it once (`src/api/init.ts:93`, `src/cli/commands/init.ts:215`).
  Test: `gitignore-manager.test.ts`. Done when: first run adds 1 line; a rerun or ignored repo adds 0.
- [ ] 1.4 Missing `openspec` binary is `not-assessed` in `src/cli/commands/change-status.ts`:
  `ValidationReceipt` gains `assessed?: false` and `reason?`; `validateWithOpenSpec` maps
  `ENOENT`/`EACCES`; verdict, `archivableCandidate` and text use it. Test: `change-status.test.ts`.
  Done when: with no `openspec` on `PATH`, JSON has `"assessed": false` + reason, text says `validates:
  not assessed (…)`, the verdict equals the passing one, and `archivableCandidate` is false.

## 2. Honest answers when there is no spec source

- [ ] 2.1 `orient` (`mcp-handlers/orient.ts:214-232, 405-430`): optional `specSources: { found,
  lookedFor }` when no source is found; classify it in `confidence-boundary.ts`. Tests:
  `orient.test.ts`, `completeness-invariant.test.ts`. Done when: no spec folder gives `specDomains: []`
  plus `specSources.found: []`, and a repo with `openspec/` returns the same bytes as before.
- [ ] 2.2 "run `openlore generate`" → `reason: "no-spec-source"` + `lookedFor` in `semantic.ts`,
  `analysis.ts`, `spec-link-service.ts`. Tests: beside. Done when: no response there names `openlore generate`; each names the reason.
- [ ] 2.3 `get_test_coverage` with no spec source: `coveragePercent: null` + reason, never 0 (`coverage-analyzer.ts`,
  `types/test-generator.ts`, `tool-dispatch.ts`). Test: beside. Done when: no source → `null`; 0 of 4 covered → 0.
- [ ] 2.4 CLI text: `src/cli/commands/drift.ts:680-683` (exit code stays 2), `src/api/drift.ts:76`,
  `doctor.ts:699-716, 1261` (text "Spec source", status `ok` when none), `analyze.ts`,
  `analysis-indexes.ts`. Tests: beside. Done when: `openlore drift` with no source exits 2 with "no
  spec source found; spec drift not assessed," and `doctor` shows no warning for it.
- [ ] 2.5 Decision sync and handoff name the skip: `src/cli/commands/decisions.ts` ("no OpenSpec
  corpus; decision kept in `.openlore/decisions/`"), `mcp-handlers/decisions.ts` (`sync_decisions`
  returns `skipped` with the reason), `mcp-handlers/handoff.ts:87-111, 294-303`. Tests:
  `decisions-record.test.ts`, beside. Done when: each of the 3 names the skip and creates no folder.

## 3. Config

- [ ] 3.1 `openspecPath` optional: `src/types/index.ts:22, 426`, `config-schema.ts:333` (not
  `required`), `config-manager.ts:115-119, 146-149, 283` (no backfill without an OpenSpec corpus),
  `src/pi/extension.ts:104, 609`. Tests: beside. Done when: a config without the key validates with 0
  findings, one with it reads as before, and `tsc` passes with every reader handling `undefined`.
- [ ] 3.2 New optional `adrPaths: string[]` (read-only ADR folders, confined to the repo):
  `src/types/index.ts`, `config-schema.ts:302-331, 346`. Test: `config-schema.test.ts`. Done when: a
  wrong type and an outside path each give a named finding; listed in `docs/configuration.md` (11.4).

## 4. The interface, with OpenSpec behind it (no behavior change)

- [ ] 4.1 New `src/core/spec-sources/types.ts` and `index.ts`: `SpecSource`, `SpecItem`,
  `detectSpecSources`, `listSpecItems`, the fixed order. Test: `index.test.ts` (new). Done when: with
  zero adapters it returns `found: []` and the 6 ids in `lookedFor`.
- [ ] 4.2 New OpenSpec adapter `spec-sources/openspec.ts` wrapping `loadSpecCorpus`
  (`spec-link-service.ts:116`) and one shared heading parser; point `buildSpecMap`
  (`spec-mapper.ts:299-330`) and `detectExistingSpecDir` (`config-manager.ts:403-424`) at it. Tests:
  `openspec.test.ts` (new), beside. Done when: `SpecMap`/`loadSpecCorpus` output here is byte-equal
  before and after; a bare `specs/001-x/spec.md` with no `### Requirement:` is not OpenSpec.
- [ ] 4.3 Move the other listers to the adapter, one commit per file: the sites that list
  `<root>/specs/<domain>/spec.md` (`analysis-indexes.ts`, `spec-vector-index.ts`,
  `digest-generator.ts`, `mcp-handlers/semantic.ts`, `mcp-handlers/orient.ts`, `doctor.ts`). Tests:
  beside. Done when: the unit suite passes with no snapshot change and `grep -n "readdir"` in those
  files finds no direct spec listing.

## 5. Hard-coded `openspec` sites honor `openspecPath`

- [ ] 5.1 Handlers `orient.ts`, `blast-radius.ts`, `semantic.ts`, `change.ts`, `working-set.ts`.
  Tests: beside. Done when: `openspecPath: "docs"` serves `docs/specs/<domain>/spec.md` from all 5.
- [ ] 5.2 CLI and Pi: `src/cli/commands/{change-status,test,analyze,digest,import,doctor,refresh-stories}.ts`,
  `src/cli/manifest/emit.ts`, `src/pi/extension.ts`. Tests: beside. Done when: the `docs` fixture
  gives the same results as the default layout for each command.
- [ ] 5.3 Core: `codebase-digest.ts`, `scenario-parser.ts`, `corpus-intent-review.ts`, `git-diff.ts`,
  `decisions/extractor.ts`, `verification-engine.ts`, `artifact-generator.ts`, `adr-generator.ts`.
  Tests: beside. Done when: `grep -rn "'openspec/\|\"openspec/\|\`openspec/" src --include="*.ts"`
  outside tests, the OpenSpec adapter, the generator and `src/constants.ts` returns 0 lines.

## 6. Adapter: ADR folders

- [ ] 6.1 New `spec-sources/adr.ts`: read `docs/adr`, `docs/decisions` and `adrPaths`; MADR and
  Nygard shapes give title, status and decision text with `file` and `line`; other shapes the title
  only. Register it. Test: `adr.test.ts` (new). Done when: one fixture per shape lists `decision`
  items and the fixture tree hash is unchanged.
- [ ] 6.2 `orient` and `search_specs` return ADR items; `verify_claim` `decision-governed` lists a
  matching ADR as "found in ADR folder, not anchored", never as governing (`orient.ts`,
  `semantic.ts`, `claim-verification.ts`). Tests: beside, Pi parity guard. Done when: a repo with
  only `docs/adr` gets ADR items in both tools and `specSources.found` is `["adr"]`.

## 7. Adapters: markdown requirements, then tests as intent

- [ ] 7.1 New `spec-sources/markdown-requirements.ts`: tracked `*.md` outside other sources; sentences
  with upper-case SHALL / MUST / SHOULD or the EARS shape "WHEN … THE … SHALL"; a file counts with 3
  or more matches. Test: `markdown-requirements.test.ts` (new). Done when: EARS and RFC 2119 fixtures
  list every sentence with its line, and a README with lower-case "you must" lists 0.
- [ ] 7.2 New `spec-sources/tests.ts`: where `isTestFile` (`test-file.ts:97`) is true, list
  `describe` / `it` / `test` titles (TS, JS), `def test_*` (Python), `func Test*` (Go) as
  `test-intent`; others not assessed, named in `lookedFor`. Test: `tests.test.ts` (new). Done when:
  each language's fixture lists titles with lines; `tests` alone never fills `specSources.found` (design 3).

## 8. Adapter: Kiro

- [ ] 8.1 Confirm the layout against the Kiro specs documentation at kiro.dev (record the page URL and
  date); write it at the top of `spec-sources/kiro.ts` (new). Assumed: `.kiro/specs/<feature>/`
  `requirements.md`, `design.md`, `tasks.md`. Test: `src/core/spec-sources/kiro.test.ts` fixture
  mirrors the confirmed layout. Done when: the comment names the page URL and the date.
- [ ] 8.2 Numbered requirements and EARS acceptance criteria as `requirement`, checkboxes as `task`.
  Test: `kiro.test.ts`. Done when: every criterion is listed with its line and nothing is written.

## 9. Adapter: Spec Kit

- [ ] 9.1 Confirm the layout against `templates/spec-template.md` in the github/spec-kit repository at
  its latest release tag (record the tag); write it at the top of `spec-sources/spec-kit.ts` (new).
  Assumed: `.specify/`; `specs/<NNN-feature>/{spec,plan,tasks}.md`; `FR-NNN`; Given/When/Then.
  Test: `src/core/spec-sources/spec-kit.test.ts`. Done when: the comment names the tag.
- [ ] 9.2 `FR-NNN` lines as `requirement`, scenarios as `scenario`, `tasks.md` checkboxes as `task`.
  Test: `spec-kit.test.ts`. Done when: `.specify/` plus `specs/001-x/spec.md` is detected as
  `spec-kit`, not `openspec`, and a repo with both `openspec/` and `.specify/` reports both.

## 10. Text: tool descriptions

- [ ] 10.1 Reword in `src/cli/commands/mcp.ts`: `prepare_spec_generation`, `prepare_spec_repair`,
  `get_mapping` (drop "llm / heuristic" and "Requires openlore generate"), `check_spec_drift`,
  `list_spec_domains`, `search_specs`, `get_spec`, `generate_change_proposal`, `generate_tests`,
  `get_test_coverage`, `get_handoff_briefing`, `sync_decisions`; names and schemas unchanged. Tests:
  `tool-contract.test.ts`, `doc-claim-sync.test.ts`, `extension.test.ts`. Done when: each says what
  happens with no spec source, or "OpenSpec-format" where it writes that format.

## 11. Text: install, skills, docs, examples

- [ ] 11.1 Install and first-run text: `src/cli/install/index.ts:814-827` (uninstall note),
  `src/cli/commands/orient.ts:115, 284`; the digest's spec line is `adopt-agent-context-interop` task
  1.2. Coordinate with hook-reliability 8.4, which edits the same block. Test: `install.test.ts`.
  Done when: no install text says a spec folder was created.
- [ ] 11.2 Skills: make OpenSpec steps conditional ("if the repo has an OpenSpec corpus") in
  `skills/{openlore-generate,openlore-repair,openlore-brainstorm,openlore-implement-story,openlore-write-tests}/SKILL.md`.
  Test: `skill-wrapper.test.ts`. Done when: no skill stops or fails when `openspec/` is absent.
- [ ] 11.3 Examples: `examples/spec-kit/` (`commands/orient.md`, `commands/drift.md`, `README.md`,
  `extension.yml`), `examples/gsd/`, `examples/bmad/`, `examples/opencode/plugins/` read specs through
  OpenLore, not `ls openspec/specs/`. Test: `src/cli/commands/docs-index.test.ts` (add the grep as a
  case). Done when: `grep -rn "ls .*openspec/specs" examples` is empty outside `openspec-cli/`, `openspec-analysis/`.
- [ ] 11.4 Docs: new `docs/spec-sources.md` (detection table, limits); update `docs/configuration.md`
  (`openspecPath` optional, `adrPaths`), `docs/install.md` (no folder at first run, the one
  `.gitignore` line), `docs/mcp-tools.md`, `docs/drift-detection.md`, `docs/TROUBLESHOOTING.md:196`,
  `docs/agents/domain.md:14`, `README.md`. `docs/OPENSPEC-INTEGRATION.md` stays (curate-product-surface
  merges `OPENSPEC-FORMAT.md` into it); `plugin/` README only if PR #727 landed. Test:
  `src/doc-claim-sync.test.ts`. Done when: no doc says OpenSpec or `openlore generate` is required.
