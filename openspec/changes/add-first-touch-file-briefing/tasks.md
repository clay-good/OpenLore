# Tasks

## 1. The briefing

- [ ] 1.1 Add `renderFileBriefing(root, file, moment)` in a new `src/core/services/file-briefing.ts`.
      It returns the closed list of lines from the proposal, each with its proof, or nothing. Test:
      `src/core/services/file-briefing.test.ts` on a fixture repository. Done when each line kind
      appears for a file that has it, and a file with none returns nothing.
- [ ] 1.2 Leave out facts that the session ledger's served set already holds. Test:
      `src/core/services/file-briefing.test.ts`. Done when a symbol `orient` served is not listed again.
- [ ] 1.3 When the file's hash differs from the index, say so in line 1 and keep only lines 2 and 3.
      Test: same file. Done when an edited fixture file gets the stale line and no caller line.

## 2. Hook moments

- [ ] 2.1 Add `after-read` to `HOOK_MOMENTS` (`src/core/services/hook-session.ts`) and a fast-exit
      entry that checks the session record before importing the CLI. Test:
      `src/cli/commands/hook.test.ts`. Done when a repeat touch prints nothing and the latency test
      shows p95 ≤ 150 ms on the fixture.
- [ ] 2.2 Call `renderFileBriefing` from `after-read` and from `before-edit` for a file not yet
      briefed, inside each moment's budget (`BUDGET_CHARS`, `TIMEOUT_MS`). Test:
      `src/cli/commands/hook.test.ts`. Done when the first read prints the briefing as
      `additionalContext`, the second read prints nothing, and a timeout prints nothing.
- [ ] 2.3 Wire `PostToolUse` with matcher `Read` in `MANAGED_HOOKS`
      (`src/cli/install/adapters/claude-code.ts`), per repository only. Test:
      `src/cli/install/install.test.ts`. Done when install adds the group, uninstall removes it,
      and a user-scope install does not add it.
- [ ] 2.4 `hooks.after-read: false` turns the moment off; `openlore status` lists it in
      `hookMoments`. Test: `src/cli/commands/status.test.ts`.

## 3. Proof from use

- [ ] 3.1 Run the built CLI in this repository: read 10 files from a real task and record which
      briefings were printed and whether each line was correct by hand. Done when the PR body
      holds the table and no line was wrong.
