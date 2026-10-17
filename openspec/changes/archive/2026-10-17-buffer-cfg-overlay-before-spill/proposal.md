# The CFG overlay should stay in memory until it is actually large

> Status: **BUILT** (2026-07-31). Closes the perf regret filed as issue #306, the last open piece of
> the repo-size hardening arc (#302 → #303 / #305 / #309, #304). Deterministic, no LLM, no new
> dependency. `cfg_overlay` is byte-identical to before.

## The gap

Bounding the CFG/def-use overlay's memory (issue #304) shipped as an unconditional spill: every
`openlore analyze`, on every repository, wrote the whole overlay to a temp file and read it back to
hand it to SQLite. That bound only matters when the overlay is genuinely large — and it almost never
is. Measured overlays: **5.5 MB** on OpenLore, **34 MB** on microsoft/TypeScript (its 65,971
functions). Both fit in memory with room to spare, yet both paid a full disk round-trip.

Issue #306 measured the cost: **+14%** of analyze wall-clock on a 3,500-file / 205 MB repository
(247s vs 217s, three back-to-back pairs, variance under 2%). The `JSON.stringify` was always
happening at insert time; the added work is purely the file write and read-back that buys a bound the
repository did not need.

## What changes

The spill becomes a buffer that **overflows** to disk instead of a file that is always written.

- The overlay accumulates in memory as each file's CFGs are serialized (the same eager
  serialization #304 introduced, so the live CFG objects still become collectable immediately).
- Past a threshold (`OVERFLOW_THRESHOLD_BYTES`, 64 MB — above every overlay measured on a real
  repository) the buffer **overflows once** to a file, and every subsequent row streams there. Peak
  residency becomes `min(overlay, threshold)` plus one write batch — issue #304's bound, preserved
  exactly where it is needed.
- The drain reads from memory when the overlay never overflowed, and from the file when it did. Both
  frame each row identically and parse it through the same reader, so `cfg_overlay` is byte-identical
  whichever path a build takes.

On the common case no file is created at all, so the 14% round-trip disappears. `openlore analyze`
never touches the disk for the overlay unless the overlay is large enough that the bound earns its
cost.

## The two hazards this deliberately avoids

Both are documented on the issue by whoever prototyped and reverted an earlier attempt:

- **`createWriteStream` reports failure asynchronously**, long after the method has committed to the
  on-disk path, which makes an in-memory fallback unreachable. The overflow uses `openSync` /
  `writeSync` so a failure is catchable at the point it happens, and `writeSync` is looped until
  every byte lands (a single call can short-write a large payload and silently truncate the spill).
- **A failed overflow that retried per write** reopened and rewrote the whole buffer for every
  function past the threshold — measured 5× slower. The failed state **latches**: once an overflow
  fails, the spill is inert (the overlay degrades to a disclosed function-granularity answer, exactly
  as a failed insert already did) and no later write reopens the file.

## Deliberately NOT in this change

The last case on issue #302 — a synthetic repository with ~1.4 million functions OOMing at a 2 GB
heap — is **inherent, not a leak**: the call graph's own nodes and edges do not fit in 2 GB at that
scale, independent of the overlay. It is a different problem from the one #302 reported (microsoft/
TypeScript, 80,113 files, now exits 0) and is out of scope here. Raising the heap
(`--max-old-space-size`) is the mitigation for a repository that large.

## Why it stays fixed

`cfg-spill.test.ts` runs the round-trip on **both** paths from one fixture and asserts the drained
rows are identical, drives the overflow from a lowered threshold (`_setOverflowThresholdBytesForTesting`)
rather than a multi-megabyte fixture, asserts the common case leaves **no file** under the output
directory, and asserts a failed overflow is attempted at most once (the row count stays at 1 across
500 further writes). An end-to-end analyze of a real source tree confirmed `cfg_overlay` is
byte-identical (same 979 rows, same content hash) between the in-memory default and a
threshold-forced disk build, with no spill file left behind by either.
