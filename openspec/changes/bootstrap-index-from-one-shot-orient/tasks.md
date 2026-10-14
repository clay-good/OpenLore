# Tasks

## 1. Detached build

- [ ] 1.1 Add a detached, cross-process-locked build entry point in `cold-start-bootstrap.ts` that
  reuses `autoInitSuppression`; verify two concurrent calls start one child process
- [ ] 1.2 Verify the parent process exits without waiting for the child

## 2. One-shot orient

- [ ] 2.1 Start the build from `orient --task`, `orient --inject`, and the primer when the index is
  absent; verify the command returns not-ready with a "build in progress" reason and exits 0
- [ ] 2.2 Start the build when the staleness check reports stale cited files; verify the stale
  answer is still served with its disclosure
- [ ] 2.3 Verify an opted-out repo and a non-git directory start no build and name the reason
- [ ] 2.4 Verify stdout holds only the JSON or injection block

## 3. Verification

- [ ] 3.1 End-to-end: in a fresh git worktree, the first `orient --json --task` starts a build and a
  later call returns a real orientation, with no manual `openlore analyze`
