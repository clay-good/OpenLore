## 1. Decision and groundwork

- [x] 1.1 Record a decision (`openlore decisions record`, or the `record_decision` MCP tool) that Pi adopts a lean default surface with task-group activation, reversing the "presets are MCP-wire only" position; verify it appears in `openlore decisions list` as a draft
- [x] 1.2 Add `toolSurface?: 'lean' | 'all'` to the Pi config type in `src/types/index.ts` and verify `npm run typecheck` passes
- [x] 1.3 Add a direct reader for `pi.toolSurface` (the `piMaySpawnDaemon` pattern: any value other than `"all"` selects lean, unreadable config selects lean) and verify unit tests for absent, `"all"`, `"lean"`, malformed, and no-provider configs pass

## 2. Short snippets and budget

- [x] 2.1 Add a required one-line `snippet` to every `NAV_TOOLS` entry and use it as `promptSnippet`; verify a test fails when a snippet equals its description or contains a line break
- [x] 2.2 Add a deterministic standing-context estimator for the Pi `lean` and `all` surfaces (schema + snippet + guideline, chars/4) with reviewed budgets that record the measured baseline and headroom; verify the budget test passes and fails when a budget is lowered below the estimate

## 3. Groups and lean surface

- [x] 3.1 Add the exported group table (lean set + `specs`, `memory`, `review`, `quality`, `inspect`) per design D2; verify a coverage test fails when a registered non-lean tool is in no group or in two groups
- [x] 3.2 Add a test that derives the expected Pi lean set from the MCP `substrate` preset plus `configure` and `activate_tools`; verify it fails when one tool is removed from the lean set
- [x] 3.3 In `session_start`, snapshot active tools, record the host-excluded OpenLore tools, and apply the lean surface with `setActiveTools` without changing non-OpenLore tools; verify with the mocked `ExtensionAPI` that non-OpenLore active tools are unchanged and that only the lean OpenLore tools are active
- [x] 3.4 In `"all"` mode, keep every OpenLore tool active and deactivate only the activator; verify with a mocked-API test
- [x] 3.5 Confirm the parity guard still passes with registered but inactive tools; add the "registered but inactive counts as surfaced" test case

## 4. Activator tool

- [x] 4.1 Register `openlore_activate_tools({ names })` with a description that lists each group and its tools and a guideline that names the tool; verify a test asserts every group and every group tool appears in the description
- [x] 4.2 Implement name resolution (group name, tool name with or without `openlore_` prefix) with all-or-nothing validation; verify tests for a valid group, a tool name, an unknown name (error lists groups, nothing activated), and a repeated activation (no change, reported as already active)
- [x] 4.3 Skip host-excluded tools and report them in the result; verify with a mocked-API test in which one group tool was inactive at session start

## 5. Docs and guards

- [x] 5.1 Update the file header of `src/pi/extension.ts` and the Pi sections of `docs/install.md` and `docs/cli-reference.md` (lean default, groups, `pi.toolSurface`); verify the `QuantitativeDocClaimsAreGuarded` test passes and no doc states a hard-coded Pi tool count that is not tied to code
- [x] 5.2 Run `select_tests` for the diff and the full Pi test file (`vitest run src/pi`), plus `npm run typecheck` and lint; verify all pass

## 6. Default and release

- [x] 6.1 Ship `"lean"` as the default; verify a test asserts that an absent `pi.toolSurface` selects the lean surface
- [x] 6.2 Approve the decision from 1.1, citing ADR-0023 and parity with the Claude Code default; verify `openlore decisions list` shows it approved
- [x] 6.3 Add a release-notes entry naming the lean Pi default, the activator, and the `pi.toolSurface: "all"` escape; verify `openspec validate add-pi-lean-tool-surface --strict` passes
