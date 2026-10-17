## ADDED Requirements

### Requirement: AWatcherFlushNeverSkipsSilently

The incremental watcher's debounced flush drains its pending set destructively — `pending` is
emptied before the first `await`, so the file events exist only inside the running batch. Every exit
from that batch SHALL therefore do exactly one of three things: commit the work, put it back in the
queue, or disclose that it was dropped. A fourth outcome, in which a change simply disappears, SHALL
NOT exist.

A read failure SHALL be classified rather than assumed. `ENOENT`/`ENOTDIR` means the file really is
gone between the event and the read, is expected on a watch lane, and is owned by the deletion lane;
it stays silent. Every other read failure — a confinement or descriptor-identity rejection, a
sharing violation, a permission error — is a read that could have succeeded, and SHALL be disclosed
and re-queued rather than treated as a deletion. In particular, a batch that ends with no readable
candidates because of such a failure SHALL NOT return silently.

A batch that fails for a reason the contention handlers do not recognize (an `EPERM` on the artifact
rename, a hard-link failure acquiring the advisory lock, `ENOSPC`, `EIO`) SHALL be re-queued, not
discarded. Both re-queues SHALL be bounded, so a deterministic failure degrades to one loud drop
instead of an unbounded retry loop. The bound is per path and SHALL reset only on a pass that
actually consumed that path: a failure occurring AFTER the file was read must not refill the budget,
or the bound is unreachable for exactly the failures it exists to bound.

When the bound is exhausted the watcher SHALL leave a signal that outlives the log line. A line on
stderr in a long-lived daemon is not something an agent can read, so where a graph store exists the
abandoned files SHALL additionally be recorded stale, through the same mechanism and behind the same
source-candidate filter the bulk-fallback lane uses — a watched non-source file has no graph nodes,
so a stale row for it could never be cleared by a re-parse.

Shutdown SHALL obey the same rule. A shutdown batch the watcher could not flush SHALL be returned to
the queue before the "still deferred" disclosure counts it, so a lost batch can never present as a
clean stop.

A flush that is neither finished nor failed SHALL disclose itself. The analysis lock is acquired
without a bound by design — a caller promising serialization must not abandon it — so the wait SHALL
be reported, not shortened.

The VCS settle window SHALL close even when the settle flush finds nothing to do, so a `.git` write
carrying no indexable file change cannot latch it and leave the hard batch ceiling permanently
unarmable.

The atomic artifact write SHALL survive a destination that is briefly held by another handle. POSIX
`rename(2)` replaces the destination unconditionally, but Windows `MoveFileExW(REPLACE_EXISTING)`
needs DELETE access to the target and fails with `EPERM`/`EACCES`/`EBUSY` while any other handle is
open on it without `FILE_SHARE_DELETE` — an antivirus or indexer scanning the file it just saw
written. The commit rename SHALL therefore be retried with a bounded backoff on exactly those codes.
Atomicity is unaffected: the temp file is still present and fsync'd, so each attempt is the same
single atomic replace. An error that is not destination contention SHALL NOT be retried, and the
original error SHALL be rethrown when the bound is reached, so a genuine permission problem or a
full disk still fails with its own message.

Guarded by `mcp-watcher-flush-durability.test.ts`, which injects each failure deterministically,
and by `atomic-write-rename-contention.test.ts` for the rename. The
platform trigger that motivated this (a Windows sharing violation making the confined read's
descriptor-identity check fail closed) is not reproducible off Windows; the durability contract is
what the guard pins, on every platform.

#### Scenario: A transient read failure costs one debounce, not the index

- **GIVEN** the only file in a batch cannot be read for a reason other than being deleted
- **WHEN** the flush runs
- **THEN** the watcher discloses the failure and re-queues the file, and the next debounce lands the
  change on disk — rather than returning silently and leaving the artifact at its previous content

#### Scenario: A failure after the read is still bounded

- **GIVEN** a batch whose files read successfully but whose artifact write fails every time
- **WHEN** the watcher retries
- **THEN** it makes a bounded number of attempts and then discloses the drop, rather than retrying
  once per debounce forever

#### Scenario: An abandoned change is discoverable, not merely logged

- **GIVEN** the watcher has exhausted its retry budget on a source file and a graph store exists
- **WHEN** a later reader asks the store what is stale
- **THEN** that file is listed, so the gap is disclosed instead of the index being served as complete

#### Scenario: Shutdown cannot report a clean stop over lost work

- **GIVEN** the shutdown drain fails to flush its batch
- **WHEN** `stop()` finishes
- **THEN** it names the still-deferred changes and points at `analyze`, instead of printing only
  `stopped`

#### Scenario: A scanner holding the artifact does not cost the write

- **GIVEN** the commit rename fails because another handle is open on the destination
- **WHEN** the writer retries within its bound
- **THEN** the new content is committed — rather than the artifact being left at its previous
  content with only a log line to say why

#### Scenario: A git operation with no file change cannot stall the ceiling

- **GIVEN** a `.git` write that changes no indexable file, so the settle flush finds an empty queue
- **WHEN** ordinary file events resume afterwards
- **THEN** the hard batch ceiling is armed again, so a steady write stream cannot postpone the flush
  without bound
