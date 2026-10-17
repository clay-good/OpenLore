# Tasks — buffer the CFG overlay, overflow to disk only past a threshold

> Status: **BUILT** (2026-07-31). cfg-spill suite green (14/14); typecheck, lint, build clean;
> end-to-end overlay identity verified on real source.

## The change
- [x] `cfg-spill.ts`: the spill is now a memory buffer with a `memory | disk | failed` mode. Rows
      accumulate serialized in memory; `open` no longer touches the disk
- [x] Overflow past `OVERFLOW_THRESHOLD_BYTES` (64 MB, `OPENLORE_CFG_OVERLAY_MEMORY_BYTES` override):
      `openSync` the file, drain the buffer to it in bounded sub-batches, stream subsequent rows there
- [x] `drain()` reads from memory when the overlay never overflowed, from the file when it did —
      both parsed through the same `parseRow`, so `cfg_overlay` is byte-identical either way
- [x] `writeAllSync` loops until every byte lands (a large `writeSync` can short-write)
- [x] Failed overflow latches `failed` and removes any partial file — attempted at most once, never
      retried per write. A failed spill is inert; the consumer skips it and the overlay degrades to a
      disclosed function-granularity answer, exactly as a failed insert already did
- [x] `artifact-generator.ts`: `open` can no longer fail at call time, so the vacuous `?? undefined`
      is dropped and the comment explains that an unwritable directory now surfaces at overflow

## Verification
- [x] `cfg-spill.test.ts`: round-trip asserted identical on BOTH paths from one fixture; overflow
      driven by a lowered threshold, not a multi-megabyte fixture; common case leaves no file;
      mid-stream overflow keeps every row across the boundary; framing survives a repo-controlled
      tab/newline on the on-disk path; empty spill produces no rows and no file
- [x] Failed overflow: degrades to a disclosed empty overlay without throwing; attempted at most once
      (`count` stays 1 across 500 further writes — catches a removed early return)
- [x] Test helper `withOverflowThreshold` is `async` and awaits its body — a synchronous wrapper
      restored the threshold before the awaited writes ran, so the overflow never fired and every
      threshold-driven case silently passed against the wrong mode. Fixed before trusting a green run
- [x] **End-to-end**: analyzed a real source tree twice — the 64 MB default (memory) and a
      threshold-0 build (disk) — and diffed `cfg_overlay`: 979 rows, identical content hash, zero
      spill files left by either path
- [x] cfg-spill, cfg-overlay-storage, hash-keyed-analyze, artifact-output-determinism,
      bounded-computation, env-extractor, graph, mcp-watcher, mcp-presets suites green in isolation
      (a batch run tripped a 10s afterEach hook timeout under concurrent transform load, not a
      regression — each passes alone in well under a second)
- [x] typecheck (0 errors on a clean install), lint, build all clean

## Traps recorded
- [x] The overflow file is created LAZILY, so `CfgSpill.open` no longer returns `null` on a bad
      directory — the failure moved to overflow time. The prior "returns null when the directory
      cannot be written" test was rewritten to force an overflow into a missing directory and assert
      the spill latches `failed` and stays inert
- [x] Frames carry the trailing newline they are written with; the on-disk reader splits it off
      before parsing, so the in-memory drain strips it too — otherwise the final field would carry a
      stray `\n` and break byte-identity
