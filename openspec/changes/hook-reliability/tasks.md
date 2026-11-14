# Tasks: hook-reliability

Each group is one small PR, in this order. Paths are from the repository root. This change edits
nothing outside its own folder; every file below is edited when the group is built.

## 1. Measure

- [ ] 1.1 Add `scripts/bench-hooks.ts` (new) and the fixture builder `src/cli/commands/hook-fixture.ts`
  (new: 200 files, 2,000 functions, one `openlore analyze`). Run each of the four moments 30 times
  on the fixture and on this repository; print p50 and p95 for the handler in-process and for the
  spawned CLI. Test: `src/cli/commands/hook-fixture.test.ts` (new: the fixture has the stated size).
  Done when: the measured table is pasted into `design.md` section 2, each proposed target and
  runtime limit is marked confirmed or corrected by the rule there, and the owner has seen any
  number that the rule does not settle. Measure before-stop with the three reframe evidence
  sources wired, if reframe group 3 has landed.

## 2. Fail-open contract tests

- [ ] 2.1 Add `src/cli/commands/hook-fail-open.test.ts` (new). For every moment in `HOOK_MOMENTS`
  (`before-edit`, `after-tools`, `before-stop`, `after-compact`, `before-subagent`, `subagent-start`): a check module that throws (`vi.doMock`), `timeoutMs: 1`, no `.openlore/`,
  `.openlore` as a file, corrupt `config.json`, corrupt session record, no index, a truncated index
  file, a read-only `.openlore/`, empty stdin, non-JSON stdin. Edit `src/cli/commands/hook.ts` only
  where a case fails. Done when: every case returns `{ stdout: '', exitCode: 0 }` and the file
  passes with `npx vitest run src/cli/commands/hook-fail-open.test.ts`.
- [ ] 2.2 Spawn test `src/cli/commands/hook-fail-open.integration.test.ts` (new; add it to
  `test:integration:ci` in `package.json`): run the built CLI for each moment in a directory with a
  corrupt `.openlore/`. Done when: exit code 0, stdout empty, stderr empty for every moment.

## 3. Prompt-submitted moment under the contract

- [ ] 3.1 Move `deliveredDir`, `deliveredPath`, `readSession`, `writeSession`
  (`src/cli/commands/hook.ts:222-262`) unchanged into `src/core/services/hook-session.ts` (new);
  export `LOOP_MOMENTS = ['prompt-submitted', ...HOOK_MOMENTS]`. Test:
  `src/core/services/hook-session.test.ts` (new) and the existing `src/cli/commands/hook.test.ts`.
  Done when: `hook.test.ts` passes with no change to its assertions.
- [ ] 3.2 Wrap `runInject` (`src/cli/commands/orient.ts:66`) in the moment wrapper: off switch,
  runtime limit from task 1.1, silent on a thrown error or the limit, `session_id` read from the
  stdin payload (`extractPrompt` in `src/cli/commands/orient-inject-render.ts`). The `error` pointer
  line is no longer printed. Test: `src/cli/commands/orient-inject.test.ts` and the prompt-submitted
  cases added to `hook-fail-open.test.ts`. Done when: a throwing `buildInjection` gives empty stdout
  and exit 0; a strong match still prints the block; the gate pointer lines are unchanged.
- [ ] 3.3 Add `'prompt-submitted'?: boolean` to `HooksConfig` (`src/types/index.ts:130`) and to
  `hooksRule` (`src/core/services/config-schema.ts:289`). Test:
  `src/core/services/config-schema.test.ts`. Done when: `hooks: { "prompt-submitted": false }`
  validates, and `orient --inject` then prints nothing.
- [ ] 3.4 List the moment in `collectHookMoments` (`src/cli/commands/status.ts:104-120`): wired when
  `UserPromptSubmit` has an `_openlore` group with no `_openloreHook`; off when
  `hooks.prompt-submitted` is false or `contextInjection.mode` is `off`. Do not change
  `MANAGED_HOOKS`. Test: `src/cli/commands/status.test.ts`. Done when: `openlore status` lists
  `prompt-submitted` after `openlore install`, and `(off)` after either switch.
- [ ] 3.5 Docs: `docs/install.md` ("Agent-loop hooks" and "Performance and activation notes") and
  `docs/configuration.md` ("Agent-loop hooks"): the fourth moment, its off switch, silence on
  failure. Test: `src/doc-claim-sync.test.ts` still passes. Done when: both pages
  name `hooks.prompt-submitted`.

## 4. Once per session

- [ ] 4.1 Add `findingIdentity(code, subject, proof)` and the `findings` map to
  `src/core/services/hook-session.ts` (design section 3). Keep writing `keys`. Test:
  `src/core/services/hook-session.test.ts`. Done when: a changed line number keeps the identity, a
  changed cited line changes it, and a record written by the current release still reads.
- [ ] 4.2 In `src/cli/commands/hook.ts`, give every `HookItem` a `code`, `subject`, and `proof`
  (lines 308-313, 351-354, 376-379, 389, 411, 419, 439-491, 504) and filter with the identity and
  audience instead of the text key (line 676). Print `[f:<8 hex>]` after each finding. Test:
  `src/cli/commands/hook.test.ts`. Done when: a finding shown at `after-tools` is not shown again
  at `before-edit` or `after-tools` in the session, is shown once in the stop receipt, and is shown
  again after its cited line changes.
- [ ] 4.3 Prompt submitted: record the no-index line and the build note as notices and state each
  once per session (`src/cli/commands/orient.ts:96-104`). Test:
  `src/cli/commands/orient-inject.test.ts`. Done when: 2 prompts in one session with no index print
  the line once; a new `session_id` prints it again.
- [ ] 4.4 Pi: the receipt text now carries finding ids. Check
  `src/pi/extension.test.ts` (after-tools receipt cases) and the MCP↔Pi parity guard
  (`src/pi/extension.test.ts:1330-1365`). Done when: both pass with no tool-shape change.

## 5. Latency budget test

- [ ] 5.1 Set the confirmed runtime limits in `TIMEOUT_MS` (`src/cli/commands/hook.ts:55`) and for
  prompt-submitted in the wrapper from 3.2. Test: `src/cli/commands/hook.test.ts` (timeout case).
  Done when: no limit is above its harness timeout in `MANAGED_HOOKS`.
- [ ] 5.2 Add `src/cli/commands/hook-latency.test.ts` (new) with the method of design section 2,
  and add the file to the `test:budgets` script in `package.json`. Done when: `npm run
  test:budgets` passes 10 times in a row locally and the test fails when a 2 s sleep is put in
  `beforeEdit`.
- [ ] 5.3 Add `src/cli/commands/hook-latency.integration.test.ts` (new; in `test:integration:ci`):
  5 spawns per moment, median against target × multiplier; record only on Windows. Done when: it
  passes on the Linux and macOS CI jobs.

## 6. Health line

- [ ] 6.1 Add `src/core/services/hook-health.ts` (new): `recordHookRun` appends
  `{ t, moment, ms, outcome, shown }` to `.openlore/session-ledger/hook-runs.jsonl`, cuts the file
  at 1 MB, and never throws; `readHookHealth` returns per moment last run, p95, errors, overruns,
  shown, over 7 days. Call `recordHookRun` from the wrapper for all four moments. Test:
  `src/core/services/hook-health.test.ts` (new). Done when: 20 parallel appends give 20 readable
  lines, a corrupt line is skipped, and an unwritable directory changes no hook output.
- [ ] 6.2 Print one `Hook health` line and add `hookHealth` to `--json` in
  `src/cli/commands/status.ts` (after the `Loop hooks` line, 352-355). Test:
  `src/cli/commands/status.test.ts`. Done when: the line shows each moment's last run and p95, the
  error and overrun totals, and findings shown; with no run recorded the line is absent.

## 7. Acted-on counts

- [ ] 7.1 In `src/cli/commands/hook.ts`, set finding states in the session record: `fixed` and
  `open` by the rules of design section 4, at `after-tools` (for the edited file's checks) and
  `before-stop`. A check that failed or timed out changes no state. Test:
  `src/cli/commands/hook.test.ts`. Done when: show, edit away, re-run gives `fixed`; show, stop
  gives `open`; a failed check leaves the state unset.
- [ ] 7.2 In `readHookHealth`, count `decided` by joining finding ids with decision text from
  `loadDecisionStore` (`src/core/decisions/store.ts:32`, `readOnly: true`), and add
  `fixed / decided / open / not assessed` to the health line and `hookHealth`. Test:
  `src/core/services/hook-health.test.ts`. Done when: a decision whose rationale contains
  `f:1a2b3c4d` moves that finding to `decided`, and the 4 counts sum to findings shown.
- [ ] 7.3 Docs: `docs/session-ledger.md` (new section "Hook runs and finding outcomes": the 2 files,
  the 4 states, local only, never sent) and `docs/install.md` (health line). Test: `src/doc-claim-sync.test.ts`. Done when: both
  pages state the limits from `proposal.md`.

## 8. Upgrade and uninstall

- [ ] 8.1 Guarded command: add the runtime guard to the hook command form in
  `src/utils/platform-command.ts` (used by `managedHooks`, `src/cli/install/adapters/claude-code.ts:313-321`,
  and by `src/cli/install/adapters/codex.ts`). Test: `src/utils/platform-command.test.ts`,
  `src/utils/platform-command.posix-oracle.test.ts`, `src/cli/install/adapters/codex.test.ts`.
  Done when: running the written command with its entry file deleted gives exit 0 and no output
  under `sh` and Git Bash; a Codex group is still recognized by `LOOP_COMMAND`. If Codex does not
  run hook commands through a shell, leave its form unguarded and say so in `docs/install.md`.
- [ ] 8.2 Retired moments: in `src/cli/install/adapters/claude-code.ts`, install and uninstall also
  remove any `_openlore` group whose `_openloreHook` is not a current moment (lines 822-852,
  1033-1050). Test: `src/cli/install/install.test.ts`. Done when: a settings file with a
  `_openloreHook: "old-moment"` group has none after install and after uninstall; install twice
  gives one group per `MANAGED_HOOKS` entry; the user's own hooks are byte-identical.
- [ ] 8.3 Doctor: report a hook command whose launcher file does not exist, with the fix
  `openlore install`, in `src/cli/commands/doctor.ts` (next to the MCP launcher check, 767-780).
  Test: `src/cli/commands/doctor.test.ts`. Done when: a `.claude/settings.json` hook that names a
  missing entry path gives a warning that names the path.
- [ ] 8.4 Uninstall summary: name the skills copied by `openlore setup` as kept, with the removal
  command, in `src/cli/install/index.ts` (817-827). Test: `src/cli/install/install.test.ts`
  ("--uninstall names the retained .openlore data"). Done when: the summary lists `.openlore/` and
  each existing copied-skill directory, and deletes neither.
- [ ] 8.5 Docs: `docs/install.md` (upgrade, uninstall, what is kept, the guard and its shell
  limit). Tell `ship-claude-code-plugin` the final command form. Test: `src/doc-claim-sync.test.ts`. Done when: the page
  states what uninstall removes and keeps.
