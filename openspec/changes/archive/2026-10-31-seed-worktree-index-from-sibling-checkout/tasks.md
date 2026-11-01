# Tasks

## 1. Seed

- [x] 1.1 Find a sibling checkout by git common directory (main worktree first). Verify with a test on a real repository plus `git worktree add`.
- [x] 1.2 Verify the candidate: the generation manifest matches, the attestation is `healthy`, and no build owns it. Verify with tests for each refusal.
- [x] 1.3 Copy only the known artifacts with copy-on-write where available, refusing symlinks and runtime state. Verify with a symlink-planted fixture.
- [x] 1.4 Serve the seed with repair reason `seeded` and start the rebuild. Verify that the first `orient` returns functions.

## 2. Verification

- [x] 2.1 Dogfood on roughlogic.com: time to the first useful answer in a new worktree, before (about 23 s) and after.
- [x] 2.2 Show that a file changed on the worktree branch is the only file flagged stale before the rebuild completes.
- [x] 2.3 Run `npm run test:unit`, `npm run test:equivalence`, lint and typecheck.
