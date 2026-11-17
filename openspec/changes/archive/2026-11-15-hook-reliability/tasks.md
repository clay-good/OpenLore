# Tasks: hook-reliability

Each group is one small PR, in this order. Paths are from the repository root. This change edits
nothing outside its own folder; every file below is edited when the group is built.

## 1. Measure

- [x] 1.1 Add `scripts/bench-hooks.ts` (new) and the fixture builder `src/cli/commands/hook-fixture.ts`
  (new: 200 files, 2,000 functions, one `openlore analyze`). Run each of the four moments 30 times
  on the fixture and on this repository; print p50 and p95 for the handler in-process and for the
  spawned CLI. Test: `src/cli/commands/hook-fixture.test.ts` (new: the fixture has the stated size).
  Done when: the measured table is pasted into `design.md` section 2, each proposed target and
  runtime limit is marked confirmed or corrected by the rule there, and the owner has seen any
  number that the rule does not settle. Measure before-stop with the three reframe evidence
  sources wired, if reframe group 3 has landed.

## 2. Fail-open contract tests

- [x] 2.1 Add `src/cli/commands/hook-fail-open.test.ts` (new). For every moment in `HOOK_MOMENTS`
  (`before-edit`, `after-tools`, `before-stop`, `after-compact`, `before-subagent`, `subagent-start`): a check module that throws (`vi.doMock`), `timeoutMs: 1`, no `.openlore/`,
  `.openlore` as a file, corrupt `config.json`, corrupt session record, no index, a truncated index
  file, a read-only `.openlore/`, empty stdin, non-JSON stdin. Edit `src/cli/commands/hook.ts` only
  where a case fails. Done when: every case returns `{ stdout: '', exitCode: 0 }` and the file
  passes with `npx vitest run src/cli/commands/hook-fail-open.test.ts`.
- [x] 2.2 Spawn test `src/cli/commands/hook-fail-open.integration.test.ts` (new; add it to
  `test:integration:ci` in `package.json`): run the built CLI for each moment in a directory with a
  corrupt `.openlore/`. Done when: exit code 0, stdout empty, stderr empty for every moment.
  Built (2026-11-14): stderr is empty for every moment. Two moments may still speak, never about the
  store: `after-compact` states the git state of the change (its boundary notes are now one summary
  line, with no raw cause), and `before-stop` tells the user what it saw of the session (edits, test
  runs). Holes found and fixed: a check module that failed to load on the shell-command and
  sub-agent paths rejected `runHook`; a sync throw in the sub-agent queue escaped its `.catch`; the
  handoff pasted raw error text and temporary paths; the sub-agent briefing said "run `openlore
  analyze`" when the index was unusable.

## 3. Prompt-submitted moment under the contract

- [x] 3.1 Move `deliveredDir`, `deliveredPath`, `readSession`, `writeSession`
  (`src/cli/commands/hook.ts:222-262`) unchanged into `src/core/services/hook-session.ts` (new);
  export `LOOP_MOMENTS = ['prompt-submitted', ...HOOK_MOMENTS]`. Test:
  `src/core/services/hook-session.test.ts` (new) and the existing `src/cli/commands/hook.test.ts`.
  Done when: `hook.test.ts` passes with no change to its assertions.
- [x] 3.2 Wrap `runInject` (`src/cli/commands/orient.ts:66`) in the moment wrapper: off switch,
  runtime limit from task 1.1, silent on a thrown error or the limit, `session_id` read from the
  stdin payload (`extractPrompt` in `src/cli/commands/orient-inject-render.ts`). The `error` pointer
  line is no longer printed. Test: `src/cli/commands/orient-inject.test.ts` and the prompt-submitted
  cases added to `hook-fail-open.test.ts`. Done when: a throwing `buildInjection` gives empty stdout
  and exit 0; a strong match still prints the block; the gate pointer lines are unchanged.
  Built (2026-11-14): the limit (3 s, in-process) covers the whole moment, index bootstrap
  included; past it the process exits 0 with nothing printed. The off switch is checked first, so
  an off moment also starts no build. An `error` *result* from the lookup is silent too, not only a
  throw, and the logger is quiet, so stderr stays empty. Reading `session_id` moves to 4.3, its
  first use.
- [x] 3.3 Add `'prompt-submitted'?: boolean` to `HooksConfig` (`src/types/index.ts:130`) and to
  `hooksRule` (`src/core/services/config-schema.ts:289`). Test:
  `src/core/services/config-schema.test.ts`. Done when: `hooks: { "prompt-submitted": false }`
  validates, and `orient --inject` then prints nothing.
- [x] 3.4 List the moment in `collectHookMoments` (`src/cli/commands/status.ts:104-120`): wired when
  `UserPromptSubmit` has an `_openlore` group with no `_openloreHook`; off when
  `hooks.prompt-submitted` is false or `contextInjection.mode` is `off`. Do not change
  `MANAGED_HOOKS`. Test: `src/cli/commands/status.test.ts`. Done when: `openlore status` lists
  `prompt-submitted` after `openlore install`, and `(off)` after either switch.
- [x] 3.5 Docs: `docs/install.md` ("Agent-loop hooks" and "Performance and activation notes") and
  `docs/configuration.md` ("Agent-loop hooks"): the fourth moment, its off switch, silence on
  failure. Test: `src/doc-claim-sync.test.ts` still passes. Done when: both pages
  name `hooks.prompt-submitted`.

## 4. Once per session

- [x] 4.1 Add `findingIdentity(code, subject, proof)` and the `findings` map to
  `src/core/services/hook-session.ts` (design section 3). Keep writing `keys`. Test:
  `src/core/services/hook-session.test.ts`. Done when: a changed line number keeps the identity, a
  changed cited line changes it, and a record written by the current release still reads.
- [x] 4.2 In `src/cli/commands/hook.ts`, give every `HookItem` a `code`, `subject`, and `proof`
  (lines 308-313, 351-354, 376-379, 389, 411, 419, 439-491, 504) and filter with the identity and
  audience instead of the text key (line 676). Print `[f:<8 hex>]` after each finding. Test:
  `src/cli/commands/hook.test.ts`. Done when: a finding shown at `after-tools` is not shown again
  at `before-edit` or `after-tools` in the session, is shown once in the stop receipt, and is shown
  again after its cited line changes.
  Built (2026-11-14): a finding that cites a line uses that line's text as its proof; the
  source's discriminator is used only without a cited line (the phantom-reference discriminator
  carries the line number). A pending (before-write) finding keeps its own `pending:` code, as
  #650 decided, so a denied edit does not silence the after-write fact; an unchanged import is
  not reported by the pending check at all. Records are matched by identity; `keys` is still
  written for an older CLI.
- [x] 4.3 Prompt submitted: record the no-index line and the build note as notices and state each
  once per session (`src/cli/commands/orient.ts:96-104`). Test:
  `src/cli/commands/orient-inject.test.ts`. Done when: 2 prompts in one session with no index print
  the line once; a new `session_id` prints it again.
- [x] 4.4 Pi: the receipt text now carries finding ids. Check
  `src/pi/extension.test.ts` (after-tools receipt cases) and the MCP↔Pi parity guard
  (`src/pi/extension.test.ts:1330-1365`). Done when: both pass with no tool-shape change.

## 5. Latency budget test

- [x] 5.1 Set the confirmed runtime limits in `TIMEOUT_MS` (`src/cli/commands/hook.ts:55`) and for
  prompt-submitted in the wrapper from 3.2. Test: `src/cli/commands/hook.test.ts` (timeout case).
  Done when: no limit is above its harness timeout in `MANAGED_HOOKS`.
- [x] 5.2 Add `src/cli/commands/hook-latency.test.ts` (new) with the method of design section 2,
  and add the file to the `test:budgets` script in `package.json`. Done when: `npm run
  test:budgets` passes 10 times in a row locally and the test fails when a 2 s sleep is put in
  `beforeEdit`.
- [x] 5.3 Add `src/cli/commands/hook-latency.integration.test.ts` (new; in `test:integration:ci`):
  5 spawns per moment, median against target × multiplier; record only on Windows. Done when: it
  passes on the Linux and macOS CI jobs.
  Built (2026-11-14): before-edit 8 → 3 s, after-tools 15 → 6 s, before-stop 50 → 20 s; the
  pending-edit check inside before-edit drops from 5 to 2 s to fit. The latency test fails with a 2 s
  sleep in `beforeEdit` (p95 2,137 ms against a 1,050 ms CI budget) and also checks that the
  fixture index is used. The integration jobs run on Linux only, so the spawn test asserts there;
  on Windows it prints its numbers.

## 6. Health line

- [x] 6.1 Add `src/core/services/hook-health.ts` (new): `recordHookRun` appends
  `{ t, moment, ms, outcome, shown }` to `.openlore/session-ledger/hook-runs.jsonl`, cuts the file
  at 1 MB, and never throws; `readHookHealth` returns per moment last run, p95, errors, overruns,
  shown, over 7 days. Call `recordHookRun` from the wrapper for all four moments. Test:
  `src/core/services/hook-health.test.ts` (new). Done when: 20 parallel appends give 20 readable
  lines, a corrupt line is skipped, and an unwritable directory changes no hook output.
- [x] 6.2 Print one `Hook health` line and add `hookHealth` to `--json` in
  `src/cli/commands/status.ts` (after the `Loop hooks` line, 352-355). Test:
  `src/cli/commands/status.test.ts`. Done when: the line shows each moment's last run and p95, the
  error and overrun totals, and findings shown; with no run recorded the line is absent.
  Built (2026-11-14): `runHook` reports each run through an `onRun` callback (its result shape is
  unchanged), and the CLI records after printing, so recording never delays the agent. The
  prompt moment records too, counting a failed lookup as an error and a passed limit as an
  overrun. `recordHookRun` never creates `.openlore/`.

## 7. Acted-on counts

- [x] 7.1 In `src/cli/commands/hook.ts`, set finding states in the session record: `fixed` and
  `open` by the rules of design section 4, at `after-tools` (for the edited file's checks) and
  `before-stop`. A check that failed or timed out changes no state. Test:
  `src/cli/commands/hook.test.ts`. Done when: show, edit away, re-run gives `fixed`; show, stop
  gives `open`; a failed check leaves the state unset.
- [x] 7.2 In `readHookHealth`, count `decided` by joining finding ids with decision text from
  `loadDecisionStore` (`src/core/decisions/store.ts:32`, `readOnly: true`), and add
  `fixed / decided / open / not assessed` to the health line and `hookHealth`. Test:
  `src/core/services/hook-health.test.ts`. Done when: a decision whose rationale contains
  `f:1a2b3c4d` moves that finding to `decided`, and the 4 counts sum to findings shown.
  Built (2026-11-14): counts are per distinct finding (one identity seen by the agent and the user
  counts once), with precedence fixed > decided > open > not assessed. They are in `--json` as
  `hookOutcomes` beside `hookHealth`. A fixed finding that is reported again is shown again and is
  no longer fixed.
- [x] 7.3 Docs: `docs/session-ledger.md` (new section "Hook runs and finding outcomes": the 2 files,
  the 4 states, local only, never sent) and `docs/install.md` (health line). Test: `src/doc-claim-sync.test.ts`. Done when: both
  pages state the limits from `proposal.md`.

## 8. Upgrade and uninstall

- [x] 8.1 Guarded command: add the runtime guard to the hook command form in
  `src/utils/platform-command.ts` (used by `managedHooks`, `src/cli/install/adapters/claude-code.ts:313-321`,
  and by `src/cli/install/adapters/codex.ts`). Test: `src/utils/platform-command.test.ts`,
  `src/utils/platform-command.posix-oracle.test.ts`, `src/cli/install/adapters/codex.test.ts`.
  Done when: running the written command with its entry file deleted gives exit 0 and no output
  under `sh` and Git Bash; a Codex group is still recognized by `LOOP_COMMAND`. If Codex does not
  run hook commands through a shell, leave its form unguarded and say so in `docs/install.md`.
- [x] 8.2 Retired moments: in `src/cli/install/adapters/claude-code.ts`, install and uninstall also
  remove any `_openlore` group whose `_openloreHook` is not a current moment (lines 822-852,
  1033-1050). Test: `src/cli/install/install.test.ts`. Done when: a settings file with a
  `_openloreHook: "old-moment"` group has none after install and after uninstall; install twice
  gives one group per `MANAGED_HOOKS` entry; the user's own hooks are byte-identical.
- [x] 8.3 Doctor: report a hook command whose launcher file does not exist, with the fix
  `openlore install`, in `src/cli/commands/doctor.ts` (next to the MCP launcher check, 767-780).
  Test: `src/cli/commands/doctor.test.ts`. Done when: a `.claude/settings.json` hook that names a
  missing entry path gives a warning that names the path.
- [x] 8.4 Uninstall summary: name the skills copied by `openlore setup` as kept, with the removal
  command, in `src/cli/install/index.ts` (817-827). Test: `src/cli/install/install.test.ts`
  ("--uninstall names the retained .openlore data"). Done when: the summary lists `.openlore/` and
  each existing copied-skill directory, and deletes neither.
- [x] 8.5 Docs: `docs/install.md` (upgrade, uninstall, what is kept, the guard and its shell
  limit). Tell `ship-claude-code-plugin` the final command form. Test: `src/doc-claim-sync.test.ts`. Done when: the page
  states what uninstall removes and keeps.
  Built (2026-11-14): the guard tests the entry and Node with `-f` (not `-x`: an executable-bit
  check on `node.exe` under Git Bash is not reliable), and is proven against a real `bash` on
  every CI OS (Git Bash on Windows). Codex hooks stay unguarded (not shown to run through a shell).
  Doctor also reports an event that runs two distinct OpenLore commands for one step, grouped by
  command (Claude Code runs an identical string once); found on the owner's own machine, where a
  second checkout and an unmarked older group both ran the prompt hook. The plugin's hooks use its
  launcher, so its command form is unchanged.

## 9. Progress for the user, silence for the agent

- [x] 9.1 Confirm in the Claude Code hooks docs (code.claude.com/docs/en/hooks) that hook output
  `systemMessage` is shown to the user and not added to the model's context, and that
  `UserPromptSubmit` accepts it; record the URL and date in `src/cli/commands/orient-inject.ts`.
  Done when: the comment exists. If the docs do not confirm it, drop the user line (9.4) and keep
  the status line only.
- [x] 9.2 Progress record: the builder writes `.openlore/build-progress.json` (design section 7)
  through the atomic writer, at most once per second, and removes it at the end, in
  `src/core/services/cold-start-bootstrap.ts` and the analyze pipeline it calls;
  `collectIndexStatus` (`src/cli/commands/status.ts`) reads it, treating a dead `pid` or a 2-minute-old
  record as not building. Tests: beside. Done when: a fixture build leaves no record, and a record
  with a dead pid reads as not building.
- [x] 9.3 `openlore statusline` (`src/cli/commands/statusline.ts` `indexLabel`) and `openlore status`
  show `indexing N% (done/total files)` and then the phase name. Tests: `statusline.test.ts`,
  `status.test.ts`. Done when: the scenario numbers print exactly, with thousands separators.
- [x] 9.4 Prompt-submitted moment (`orient-inject.ts`): no build or progress line in the agent's
  context; when OpenLore's status line is not wired, one user-only line at build start and one at
  ready, per session record. Replace today's "orientation failed for this turn (the index may be
  mid-rebuild)" output with nothing (counted as in group 2). Tests: `orient-inject.test.ts`. Done
  when: a 5-prompt session during a build has 0 agent-visible progress lines and at most 2 user lines.
- [x] 9.5 Docs: `docs/install.md` (how plugin users wire `openlore statusline` in their own
  settings; what they see during a build). Tell `ship-claude-code-plugin`. Test:
  `src/doc-claim-sync.test.ts`. Done when: the page shows the status-line setting and the sample output.
  Built (2026-11-14): 9.1 checked https://code.claude.com/docs/en/hooks on 2026-11-14:
  `systemMessage` is "shown to the user" and UserPromptSubmit accepts it, but the docs do not say it
  stays out of the model's context, so the user-only line (9.4) is dropped and the status line is
  the only progress channel. Progress comes from a sink `openlore analyze` opens; Pass-1 extraction
  reports each file on both lanes (serial and worker pool). Seen live on a 1,354-file clone:
  `indexing 0% (0/1,354 files)` → `8%` → `49%` → `indexing: linking` → `index ready`, record removed.
  `openlore status` shows the build in place of "run openlore analyze" during a first build.
