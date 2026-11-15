# Tasks

Run one test file with `npx vitest run <file>`. Each group is one small PR, in this order.

## 1. Advisory by default

- [x] 1.1 Edit `src/core/services/mcp-handlers/enforcement-policy.ts`: set `defaultClass: 'advisory'`
  on the 7 codes at lines 483-518 (`corpus-reference-unresolved`, `corpus-reference-ambiguous`,
  `corpus-self-reference`, `corpus-duplicate-identifier`, `corpus-edge-unsupported`,
  `corpus-target-type-mismatch`, `corpus-supersession-cycle`). Do not change severity in
  `src/core/decisions/corpus-integrity.ts:222`. Test: `src/core/services/mcp-handlers/enforcement-policy.test.ts`
  (update the table at lines 24-33; add "no registry entry defaults to blocking or frozen").
  Done when: that test file passes and the new test fails if one entry is set back to `blocking`.
- [x] 1.2 Same file: fix the stale comment above `applyPolicyPrecedence` (lines 581-587, "which no
  current code uses") and the `FindingCodeSpec` comment (lines 86-88). New text: every source default
  is advisory; the `sourceDefault` parameter stays for the precedence contract. Fix the matching
  test comment at `enforcement-policy.test.ts:37-38`. Test: same file.
  Done when: `grep -n "no current code uses\|are blocking because" src/core/services/mcp-handlers/enforcement-policy.ts` returns nothing.
- [x] 1.3 Edit `src/cli/commands/enforce.ts`: correct the comment at lines 806-808 ("Source-declared
  defaults are policy too"); keep the code. Test: `src/cli/commands/enforce.test.ts` (add: no policy
  plus an unresolved corpus reference → `--hook` exits 0 and lists the finding as advisory; a policy
  naming the code as `blocking` → exits 1; keep the test at line 352 passing).
  Done when: `npx vitest run src/cli/commands/enforce.test.ts src/cli/commands/corpus-integrity-surfaces.test.ts src/cli/commands/doctor.test.ts` passes.
- [x] 1.4 Edit `CHANGELOG.md` under `## [Unreleased]`, new `### Changed` entry: the 7 codes are
  advisory by default; give the 7-line `enforcement.policy` block from `design.md` section 5 for
  repositories that relied on the default block. Edit `docs/configuration.md`: add 7 rows to the finding-code catalogue (after line 289), one for
  each code, with source `corpus-integrity` and default `advisory`. In line 289, replace "the
  corpus-integrity codes (blocking by default) fail on it, so a commit is blocked until it is fixed"
  with "a corpus-integrity code that `enforcement.policy` names as blocking fails on it".
  Done when: `npx vitest run src/doc-claim-sync.test.ts` passes and the CHANGELOG entry names all 7 codes.

## 2. The `plugin` preset

- [x] 2.1 Not doing (owner decision, 2026-11-15). The benchmark run that would add `verify_change`
  to `substrate` is dropped: effort goes to the accuracy of the intelligence agents receive instead.
  `substrate` stays at 15 tools; `verify_change` is in the `plugin`, `verify` and `full` presets.
  Per design section 1, the subset test keeps `verify_change` as the one plugin tool not in `substrate`.

- [x] 2.2 Edit `src/cli/commands/mcp.ts`: add `verify_change` to `substrate` (if 2.1 passed; not yet); add
  `plugin` to `TOOL_PRESETS` (line 2620) with the 11 tools in `design.md` section 2; update the
  `substrate` budget and add a `plugin` entry to `STANDING_CONTEXT_BUDGETS` with the measured
  baseline plus about 7% headroom; add `"plugin"` to the `--preset` help text (line 3484). Do not
  touch `src/constants.ts`. Test: `src/cli/commands/mcp-presets.test.ts` (add: `plugin` = exactly
  the 11 names; the guard fails above 12 tools; `plugin ⊂ substrate`; no `prepare_spec_*` in
  `plugin`; `substrate` = its 15 names plus `verify_change`).
  Done when: the test file passes and `node dist/cli/index.js mcp --preset plugin --list-tools`
  (after `npm run build`) lists 11 tools.
- [x] 2.3 Run the guards that read every preset, and fix only what the two edits make them report:
  `src/doc-claim-sync.test.ts`, `src/cli/commands/mcp-tool-count-doc.test.ts`,
  `src/core/analyzer/guidance-preset-coherence.test.ts`, `src/honesty-contract.test.ts`,
  `src/cli/commands/default-preset-single-source.test.ts`, `src/cli/commands/serve.test.ts`.
  Edit `docs/mcp-tools.md` (the `standing-context-cost` table near line 127: add the `plugin` row).
  Done when: all 6 test files pass.
- [x] 2.4 Edit `docs/mcp-tools.md`, `docs/install.md` (line 120) and `docs/cli-reference.md`
  (line 147): name the `plugin` preset, its 11 tools, `verify_change` in `substrate`, and state that every other tool stays
  available under its current name through `--preset <name>`, `--preset full` and Pi. Test:
  `src/doc-claim-sync.test.ts`.
  Done when: the test passes and `grep -c "preset plugin\|\`plugin\`" docs/mcp-tools.md` is at least 1.

## 3. Certificates as before-stop evidence

- [x] 3.1 Edit `src/cli/commands/hook.ts` (`beforeStop`, line 494): add a helper that runs one
  source with its own 10 s limit and returns at most 3 `HookItem`s, or none on error or timeout.
  Start the sources together with `handleVerifyChange`. Base ref = the `baseline` argument. Test:
  `src/cli/commands/hook.test.ts` (a source that never resolves adds no item and the receipt has no
  "passed" text for it).
  Done when: the test file passes and the existing timeout test (lines 151-156) still passes.
- [x] 3.2 Same file: wire `handleCertifyPublicSurface` (`src/core/services/mcp-handlers/public-surface.ts:1211`).
  Trigger: the session diff has a `.ts`, `.tsx`, `.js`, `.jsx` or `.py` file. Emit only findings
  classified `breaking`; the item text names the export and its consumers. Test: `hook.test.ts`
  (a removed exported function with one consumer → 1 item; a Markdown-only diff → the handler is not called).
  Done when: both cases pass.
- [x] 3.3 Same file: wire `handleCertifyServiceContract` (`src/core/services/mcp-handlers/service-contract.ts:700`;
  trigger: the diff has a file that module's reader accepts as OpenAPI, protobuf or GraphQL; emit
  `breaking` and `dangerous` changes) and `handleChangeImpactCertificate`
  (`src/core/services/mcp-handlers/impact-certificate.ts:1031`; trigger: `impactCertificate.surfaces`
  is set in `.openlore/config.json`; pass `persist: false`; emit newly opened paths). Test:
  `hook.test.ts` (one case per source for trigger and no-trigger).
  Done when: the cases pass and `grep -n "certify_provenance\|handleCertifyMerge" src/cli/commands/hook.ts` returns nothing.

## 4. Proof and action on every hook finding

- [x] 4.1 Edit `src/cli/commands/hook.ts`: add `action?: 'fix' | 'decide' | 'raise'` to
  `HookItem`; use the `code`, `subject` and `proof` fields from hook-reliability task 4.2; set
  `proof` and `action` where each item is built (before-edit, after-tools, before-stop, the 3 new
  sources); print them as labeled data next to `next`; drop an item from before-edit, after-tools
  or before-stop that has no proof; `after-compact` and `subagent-start` items are briefings and are
  exempt. Filter with the finding identity from hook-reliability (build hook-reliability group 4
  first). Test: `src/cli/commands/hook.test.ts` (each moment's item has proof and one
  action; an item with no proof is not printed; a second run in the same session prints nothing).
  Done when: the test file passes and the budget tests (lines 57-61, 294) still pass.
- [x] 4.2 Check the other harnesses carry the same text: `src/cli/install/adapters/codex.ts` and
  `runLoopMomentChild` in `src/pi/extension.ts:2347` both run `openlore hook <moment>`, so no edit
  is expected. Test: `src/cli/install/adapters/codex.test.ts`, `src/pi/extension.test.ts`.
  Done when: both files pass with no source change, or the change needed is listed in the PR.

## 5. Docs and guards

- [x] 5.1 Run the MCP↔Pi parity guard: `npx vitest run src/pi/extension.test.ts`. `NAV_TOOLS` and
  `PI_EXCLUDED_CONCLUSION_TOOLS` in `src/pi/extension.ts` must have no diff in this change.
  Done when: the file passes and `git diff --stat src/pi/extension.ts` shows only lines from 4.2, if any.
- [x] 5.2 New-user docs: remove `enforcement.policy` from `README.md` (line 204) and from the
  install path in `docs/install.md` (lines 260-267, 383); keep one link to
  `docs/configuration.md#enforcement-policy`, which stays the reference. In `docs/install.md` and
  `docs/configuration.md` (hook table near line 344) describe the four moments, the three actions,
  and the three before-stop evidence sources with their triggers.
  Done when: `grep -c "enforcement.policy" README.md` is 0 and `npx vitest run src/doc-claim-sync.test.ts src/honesty-contract.test.ts` passes.
- [x] 5.3 Run `npm run build`, `npx eslint src`, and `npx vitest run src`. Run
  `openspec validate reframe-governance-as-agent-evidence`.
  Done when: all 4 commands exit 0.
