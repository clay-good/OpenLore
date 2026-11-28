# Tasks

## 1. Base commit

- [ ] 1.1 In `writeSession` (`src/core/services/hook-session.ts`), also write
      `last-session.json` (session id, current head) in `deliveredDir`, atomically, and keep it out
      of the 7-day prune. Test: `src/core/services/hook-session.test.ts`. Done when a write updates
      the file and a prune leaves it in place.
- [ ] 1.2 Add `previousSessionHead(root, sessionId)`: the head in `last-session.json` when its
      session id differs from `sessionId`, read before this session's first write. Test: same
      file. Done when a new session gets the old head, the same session gets nothing, and a missing
      or malformed file gets nothing.

## 2. Catch-up block

- [ ] 2.1 Add `renderCatchUp(root, base)` in a new `src/core/services/session-catch-up.ts`. It
      calls `handleBriefingSince`, the decision store, and `recall`'s anchor verdicts, and returns
      the 5 lines or nothing. Test: `src/core/services/session-catch-up.test.ts`. Done when a
      fixture with one hub change prints it, and a fixture with only ordinary changes prints nothing.
- [ ] 2.2 A base that is not an ancestor of HEAD returns one "not assessed" line with the reason.
      Test: same file. Done when a rebased fixture gets the line and no symbol lines.
- [ ] 2.3 Print the block in `buildInjection` (`src/cli/commands/orient-inject.ts`) on the first
      prompt, after the slim digest, inside `contextInjection.tokenBudget`. Test:
      `src/cli/commands/orient-inject.test.ts`. Done when the first prompt carries it, the second
      does not, and an over-budget case keeps the task block.

## 3. Proof from use

- [ ] 3.1 In this repository, start a session after merging 5 commits from main and record the
      block by hand against `git log`. Done when the PR body holds the block and each line is correct.
