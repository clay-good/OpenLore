## Why

Issue #451: an incremental watcher flush intermittently never lands on Windows. The test that
caught it asserts a real product behaviour — a debounced flush reaching disk — and the observed
state is that the flush did not happen: `llm-context.json` still holds the seeded empty context,
and nothing anywhere says why.

The reported hypothesis was cross-test-file state. That is **falsified**: this repo runs vitest on
the default `forks` pool with `isolate: true`, so every test file gets its own OS process. No
module-level singleton, no leaked timer, no `vi.mock` registry and no stderr spy can cross a file
boundary, which is also why `--no-file-parallelism` changed nothing. The only channels that survive
a file boundary are the filesystem, OS resources, and IO contention — all of which point back at
the flush lane itself.

Auditing that lane found four ways a flush is silently skipped. Each is a product defect in a
long-lived MCP server, not a test artifact: a watcher that drops a file event without a signal
leaves the index stale and the agent unaware that it is reading a lie.

**1. Any read failure was treated as "the file was deleted."** `handleBatch`'s candidate loop
caught every error from `readFileConfined` with a bare `continue`, and when that emptied the batch
it returned at `files.length === 0` writing nothing and saying nothing. `readFileConfined` fails
CLOSED when the path stat and the descriptor stat disagree on identity or timestamps — which on
Windows a transient sharing violation produces, because libuv falls back to an attribute-only stat
(`ino`/`dev` zeroed, `ctim` collapsed onto `mtim`) whenever it cannot open the file for attributes.
An indexer or AV scanner holding the file for a few milliseconds is enough. Injecting one such
failure reproduces the reported symptom exactly: the seeded 43-byte context, zero output.

**2. An unrecognized flush error lost the batch permanently.** `flush()` empties `pending` before
its first await. Only two error classes put the paths back (a spec-index lock timeout, a busy
SQLite); everything else — an `EPERM` on the artifact rename, a sharing violation on the advisory
lock's hard link, `ENOSPC`, `EIO` — reached one `[mcp-watcher] error:` line and the change was gone
until the next full `analyze`. `flushBatchWithBusyRetry`'s own docstring claimed the opposite.

**3. `stop()` had the same hole, and then hid it.** Its shutdown drain dropped a failed batch the
same way, after which the "still deferred — run analyze to reconcile" disclosure read the emptied
queue and stayed silent. Shutdown reported a clean stop precisely when work had been lost.

**4. The atomic artifact write itself can fail on Windows, and did.** `atomicWriteFile` commits
with `rename(tmp, path)`. POSIX replaces the destination unconditionally; Windows does not —
`MoveFileExW(REPLACE_EXISTING)` needs DELETE access to the target, so it returns
`EPERM`/`EACCES`/`EBUSY` while any other handle is open on it without `FILE_SHARE_DELETE`. This is
observed, not theorised: a Windows CI runner produced
`EPERM: operation not permitted, rename '….llm-context.json.tmp-…' -> '…llm-context.json'`
while running this change's own durability suite, leaving the artifact at its previous content —
the #451 symptom exactly. The retry lane above turned it into a bounded, disclosed give-up instead
of a silent loss, which is how it was caught at all.

**5. An empty VCS settle window latched forever.** `vcsSettling` is cleared in exactly one place,
after `flush()`'s empty-queue early return. A `.git` write with no indexable file change —
`git commit`, `git fetch`, a checkout touching only tests — leaves it latched, and `armFlush` then
takes its settle branch on every later event and never re-arms the hard batch ceiling. A steady
sub-settle-window write stream postpones the flush without bound, with a timer always armed and
nothing to say so.

## What Changes

One rule, stated once and enforced at every exit: **the drain is destructive, so every exit from a
batch must either commit the work, re-queue it, or say out loud that it was dropped.** There is no
fourth option in which a change simply disappears.

- A read failure is classified. `ENOENT`/`ENOTDIR` is a real deletion and stays silent (the
  deletion lane owns it); anything else is disclosed and re-queued.
- Any unrecognized flush error re-queues the drained batch instead of discarding it.
- Both re-queues are bounded by `WATCH_MAX_EVENT_RETRIES` (3), so a deterministic failure degrades
  to one loud drop rather than a hot retry loop. The budget is per path and resets only on a pass
  that actually consumed the path — a failure *after* the read must not refill it.
- On give-up the abandoned files are recorded stale in the graph store, through the same mechanism
  the bulk-fallback lane already uses and behind the same source-candidate filter, so the signal
  outlives the log line and every later freshness read discloses the gap. A stderr line in a
  daemon nobody is watching is not a signal an agent can read.
- `stop()` puts a failed shutdown batch back before its own disclosure counts it.
- An empty settle drain closes the settle window.
- A flush still running after 30s says so once. The wait itself is legitimate — `acquireAnalysisLock`
  blocks without bound by design — so this shortens nothing; it only removes the silence.
- `atomicWriteFile` retries a rename that lost a race with another handle on the destination
  (`EPERM`/`EACCES`/`EBUSY`), with a bounded backoff. The temp file is still there and fully
  fsync'd, so each attempt is the same single atomic replace and atomicity is untouched. Those
  codes essentially never occur for a same-directory rename on POSIX, so nothing changes there, and
  the ORIGINAL error is rethrown when the retries run out — a genuine permission problem still
  fails with its real message. Every artifact writer benefits, not just the watcher.

The explicit-caller lane (`handleChange`, `applyRepositoryDelta`) is disclosed but never re-queued:
those await a single pass with no debounce behind them, and `applyRepositoryDelta` already reports
its own unapplied files as stale.

## Deliberately NOT changed

- **`readFileConfined`'s identity contract.** Its strictness is the TOCTOU guard for
  artifact-derived paths. Loosening it to accommodate Windows timestamp semantics would trade a
  security boundary for a freshness convenience. The watcher stops mis-reading its failures instead.
- **`acquireAnalysisLock`'s unbounded wait.** A caller promising serialization must not abandon it.
  The wait is disclosed, not shortened.
- **The hard-ceiling suppression during a settle window.** That suppression is intentional and
  pinned by an existing test; the fix is to end the window, not to re-arm inside it.
- **The Windows trigger itself.** It is not reproducible off Windows, and the durability contract
  is the part that can be pinned by a test on every platform.
