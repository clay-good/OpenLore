## 1. Stop mistaking an unreadable file for a deleted one

- [x] 1.1 Add `isMissingFileError` and split `handleBatch`'s candidate-loop `catch`: `ENOENT`/
  `ENOTDIR` stays a silent skip (the deletion lane owns it), everything else is collected as
  unreadable — verified by a test that a vanished file still produces no output.
- [x] 1.2 Add `deferUnreadable`: disclose the failure, re-queue on the watch lane, disclose-only on
  the explicit lane (`handleChange`, `applyRepositoryDelta`) — verified by a transient-failure test
  that lands on the retry, and by a `handleChange` test that asserts an empty queue and ledger.
- [x] 1.3 Cover the mixed batch: a readable file must not be held hostage by an unreadable
  neighbour, and the neighbour must still come back.

## 2. Make a drained batch unloseable

- [x] 2.1 Replace `flush()`'s terminal `.catch(stderr.write)` with `deferFailedBatch`: re-queue,
  bounded by `WATCH_MAX_EVENT_RETRIES`, deletions first and changes second so a path can never end
  in both sets — the same order the two contention deferrals already use.
- [x] 2.2 Reset the retry budget only in `flushBatchWithBusyRetry`'s post-success loop, and only for
  paths the pass did not itself re-queue. Do NOT reset on a successful read: every failure this
  change was written for (the artifact rename, the generation republish, a full disk) throws AFTER
  the read, so a reset there makes the bound unreachable — verified by a test that drives the REAL
  `handleBatch` and asserts exactly four attempts.
- [x] 2.3 Add `abandonEvents`: one loud line naming the files and the reason, plus a `markFilesStale`
  row behind the same source-candidate filter `fallbackBulkBatch` uses, so a watched markdown file
  cannot become a permanent stale row no re-parse can clear — verified against a real `EdgeStore`.
- [x] 2.4 `stop()`: re-add a failed shutdown batch before the "still deferred" disclosure counts it,
  and have `deferFailedBatch` re-queue rather than spend retry budget while `stopping` (no retry is
  coming, so counting one would be a lie).

## 3. Close the remaining silent skips

- [x] 3.1 Clear `vcsSettling`/`vcsBulkFlag` on `flush()`'s empty-queue return, so a `.git` write with
  no indexable change cannot latch the settle window and disable the hard ceiling for good.
- [x] 3.2 Add `armFlushStallDisclosure`: one line when a flush passes 30s, cleared on completion and
  on `stop()`. The wait is not shortened.
- [x] 3.3 Guard `flush()`'s `.finally` epilogue so a throw there cannot leave `running === true`
  (wedging every later flush), and `.catch` the voided promise so it cannot terminate the host.

## 4. Survive the contended rename that a Windows runner actually produced

- [x] 4.1 Retry `atomicWriteFile`'s `rename` on `EPERM`/`EACCES`/`EBUSY` with a bounded backoff,
  rethrowing the original error when it runs out — a full disk (`ENOSPC`) is not a race and is not
  retried.
- [x] 4.2 Add `atomic-write-rename-contention.test.ts`: `node:fs/promises` is mocked so the race is
  deterministic on every platform (it cannot be provoked on POSIX, and provoking it on Windows would
  mean racing a scanner). Covers all three contention codes, the overwrite case that is the #451
  symptom, the bound, the rethrown message, no-retry-on-ENOSPC, and no temp-file litter either way.

## 5. Keep the invariants stated

- [x] 5.1 Re-base `artifact-write-atomicity.test.ts`'s change-lane anchor onto `private async
  handleBatch` — `abandonEvents` is a fourth fenced writer defined earlier in the file, so "the
  first acquire" no longer names the change lane — and bump the acquisition count 3 → 4.
- [x] 5.2 Correct `flushBatchWithBusyRetry`'s docstring, which claimed no event is ever silently
  lost while only two error classes were covered.
- [x] 5.3 New `mcp-watcher-flush-durability.test.ts` (15 tests). Non-vacuity verified: 14 of 15 fail
  against the unfixed watcher; the fifteenth is the ENOENT-stays-silent regression guard, which is
  green on both sides by construction.
