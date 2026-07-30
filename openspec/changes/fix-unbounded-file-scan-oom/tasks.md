# Tasks — bound every repository-wide file scan

> Status: **BUILT** (2026-07-30). Issue #302. Full suite green — **6,511 passed, 0 failed,
> 336/336 files** — plus lint, typecheck and build. (Earlier runs showed a handful of timeouts in
> `parse-budget` / `mcp-watcher-parity`; those were contention from the multi-gigabyte analyze
> reproducers running alongside the suite. They also appeared on a clean `origin/main` worktree
> under the same load, and all pass on an uncontended run of either branch.)

## Reproducers (written first — they are the acceptance criteria)
- [x] Fan-out reproducer: 300 files × 1.5 MB (439 MB). `origin/main` dies with
      `FATAL ERROR: … JavaScript heap out of memory` under a 2 GB heap, aborting inside the
      `readFile` completion path — the same frame the issue reports. Reproduced 3/3
- [x] Per-file reproducer: one 666 MB generated file. Confirmed load-bearing by running the same
      code path with the cap disabled (`readSourceCapped(p, MAX_SAFE_INTEGER)`) — OOM with the cap
      off, skipped cleanly with it on
- [x] Scale measurement: 6,000 files / 234 MB — peak RSS **3,112 MB → 437 MB**

## The fix
- [x] `bounded-file-scan.ts`: `mapFilesBounded` (bounded width, input-order results),
      `readSourceCapped` (stat-before-read), `isOversizedForScan` (the threshold, defined once)
- [x] `SOURCE_SCAN_CONCURRENCY` (8) and `SOURCE_SCAN_MAX_FILE_BYTES` (4 MB) in `constants.ts`, each
      documented with why it is that size and why the other bound cannot replace it
- [x] All five enrichment extractors converted: UI components, schemas, routes, middleware, env vars
- [x] `call-graph.ts` `synthesizeRouteHandlerEdges` — re-reads every file from disk, same hazard
- [x] `live-data/analyze-repo.ts` — read every node's file at once to build the vector index
- [x] `extractAllHttpEdges` — its nested `Promise.all` read the SAME file twice concurrently,
      doubling per-slot residency; now sequential
- [x] `analyze.ts` phase 3: five extractors run sequentially, not as one `Promise.all`
- [x] `analyze.ts`: oversized files disclosed with path + size, inventories marked a LOWER BOUND
- [x] env scan: decide from the extension BEFORE reading — it used to decode every binary asset in
      the repository and discard it one line later
- [x] Schema and middleware scans changed from shared-array push to per-file-then-flatten. They
      aggregated in I/O-COMPLETION order, a latent byte-determinism defect that the concurrency
      bound would otherwise have made reproducible

## Verification
- [x] `bounded-file-scan.test.ts` (12): width is never exceeded (including with one slow file);
      every path visited exactly once; nonsensical widths clamped; input order held under reversed
      completion and at every width; failure matches `Promise.all` with no unhandled rejection;
      cap boundary exact; missing path and directory both null
- [x] `artifact-output-determinism.test.ts`: added cases with file lists **longer than** the
      concurrency bound. The existing cases used 3 files — under the bound of 8, so no worker ever
      waited for a slot and the bounded path was never exercised
- [x] `bounded-computation.test.ts`: structural guards — no raw `readFile` and no
      `Promise.all(x.map(` in any scan module (comments stripped first, so prose explaining the
      hazard cannot fail the guard and code cannot hide behind it); `analyze` awaits the five
      extractors separately; the disclosure is present; both bounds are still bounds
- [x] End-to-end oversized-file test through all five extractors, with the oversized file carrying
      content each one would otherwise match — so an empty result cannot pass by accident
- [x] **Mutation-tested**: every guard confirmed to FAIL when the defect is reintroduced (unbounded
      fan-out, raw `readFile`, `Promise.all` phase 3, widened cap, completion-order aggregation)
- [x] **Equivalence proof**: on a real 770-file / 198,964-line codebase, all five inventories AND
      `llm-context.json` (call graph, signatures, all three phases) are **byte-identical** to
      `origin/main`'s output

## Out of scope (recorded, not fixed)
- [ ] The call-graph build holds all file content resident for Pass 2 (type inference, import
      resolution, class hierarchy). On a 6,000-file / 234 MB repository this OOMs at a 2 GB heap on
      `main` and on this branch alike — the ceiling moves one phase later, it does not move away.
      Bounding it is a redesign (stream per-file facts through the store between passes), not a
      limiter, and belongs in its own change
