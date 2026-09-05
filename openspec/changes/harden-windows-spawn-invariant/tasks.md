## 1. State the invariant once, and enforce it

- [x] 1.1 Add `src/utils/windows-hidden-spawn-guard.test.ts`: an import-aware scanner that resolves
  `node:child_process` bindings (including aliases), masks comments and string literals
  length-preservingly so reported lines stay true, and fails on any spawn lacking `windowsHide` that
  does not inherit a console — verified by a negative control and a non-vacuity check.
- [x] 1.2 Move the git-routing guard into the same file, keyed on bindings rather than files, so one
  migrated alias no longer exempts a raw spawn beside it — verified by a mixed-import control.
- [x] 1.3 Reduce `src/utils/git-exec.test.ts` to behaviour, and make each assertion prove the option
  reaches the spawn — verified by mutation: deleting `windowsHide` turns five of them red.

## 2. Close the nine unguarded spawns

- [x] 2.1 Add `spawnGit` / `spawnGitSync` to `src/utils/git-exec.ts`, typed as `typeof spawn` /
  `typeof spawnSync` so Node's stdio-tuple narrowing survives the wrapper — verified by typecheck
  against `git cat-file --batch`'s non-nullable `child.stdin`.
- [x] 2.2 Route the three raw `git` spawns through them: `epistemic-lease.ts`, `analysis.ts`,
  `git-diff.ts`.
- [x] 2.3 Set `windowsHide` on the six non-git sites: `gryph-bridge.ts` (×2), `pi/extension.ts`'s
  POSIX branch, `prove.ts`, `agent-eval/measure.ts`, `bench/container-launch.ts`.
- [x] 2.4 Re-anchor `tls-coverage.test.ts`'s three `pi/extension.ts` exemptions, shifted by the new
  comment; make `epistemic-lease.test.ts`'s `node:child_process` mock partial, since the module now
  reaches `git-exec.ts` and its wholesale mock left `execFile` undefined at import.

## 3. Correctness fixes found in the same review

- [x] 3.1 Default `execFileGitSync` to `'utf-8'` so a plain-options call returns the `string` its
  signature promises — verified by mutation, and by a test that `{ encoding: 'buffer' }` still
  yields bytes.
- [x] 3.2 Exit on a rejected teardown in both daemon exit paths (`finally`, not `then`).
