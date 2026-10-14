# Tasks

## 1. Detached build

- [x] 1.1 Add `startDetachedIndexBuild` in `src/core/services/one-shot-index-build.ts`, reusing
  `autoInitSuppression` and full-analysis ownership; unit tests cover one start, a live supervisor,
  a live analysis owner, and the cooldown
- [x] 1.2 Add the supervisor (`orient --background-build`, hidden) that runs init and analyze as
  child processes; verified the parent returns in about 0.4 s

## 2. One-shot orient

- [x] 2.1 Start the build from `orient --task`, `orient --inject`, and the primer when the index is
  absent; the not-ready conclusion says a build is running and exits 0
- [x] 2.2 Route the read path's staleness signals to the same build; the stale answer is still
  served with "Repair has been scheduled."
- [x] 2.3 An opted-out repo and a non-git directory start no build and name the reason
- [x] 2.4 Stdout holds only the JSON or injection block

## 3. Verification

- [x] 3.1 End-to-end in a fresh git repository: the first `orient --json --task` starts a build and
  a later call returns a real orientation, with no manual `openlore analyze`; six concurrent calls
  start one build
