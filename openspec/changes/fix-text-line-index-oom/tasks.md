# Tasks — stream the text-line index build

> Status: **BUILT** (2026-07-30). Full suite green (6,484 passed, 335/335), lint, typecheck, build.

## How this was found (the reproducer IS the acceptance criterion)
- [x] Tested whether issue #304 (the CFG overlay) was the real ceiling by running the actual
      reported command — `openlore install` — on a REAL large codebase (microsoft/TypeScript,
      80,113 files, 652 MB) at the 2 GB heap the #302 reporter had
- [x] `origin/main`: **FATAL ERROR, heap out of memory** — but *after* `Function index built
      [keyword] (152046 functions)`, i.e. the call graph and keyword index both succeeded. The
      failure is in the NEXT step, the text-line index
- [x] Confirmed #304 is not the culprit by measuring the overlay on real code: 34.2 MB total on
      microsoft/TypeScript (65,971 functions, avg 544 B), vs the 1,574 MB the issue was filed on —
      which came from a synthetic fixture with ~250 B of overlay per source line

## The fix
- [x] `analyze.ts` `runTextLineIndexing`: stream files in chunks of 32 via an async generator,
      instead of collecting every file's text into one array. The reads were ALREADY pooled by
      the #302 fix — the point here is that a bounded pool still returns an unbounded result, so
      concurrency and retention had to be bounded separately
- [x] `text-line-index.ts` `TextLineIndex.build`: accept `Iterable | AsyncIterable`, flush every
      `BUILD_FLUSH_LINES` (200,000) records. First flush creates the table (`mode: 'overwrite'`),
      later flushes `add`. Array callers unchanged — `for await` accepts sync iterables
- [x] Empty-corpus behaviour preserved exactly: the table is created only on the first NON-EMPTY
      flush, so an empty repository leaves no table and an empty rebuild still drops a stale one
- [x] `_setBuildFlushLinesForTesting` — follows the existing `_resetTextLineIndexCachesForTesting`
      pattern, so a small fixture can cross the threshold many times

## Verification
- [x] Four new cases in `text-line-index.test.ts`: multi-flush survival (first/middle/last batch),
      async-iterable ≡ array, empty corpus from both input forms, empty rebuild drops a stale index
- [x] **Mutation-tested**: re-creating the table per flush fails with `zebracrossing missing — an
      earlier batch was lost`; creating a table for an empty corpus fails the two empty cases
- [x] Verified LanceDB semantics directly rather than assuming them — two `createTable(overwrite)`
      calls keep only the last rows; `createTable` + `add` keeps both
- [x] Full suite 6,484 passed / 335 files; lint; typecheck; build

## Two traps this work hit, recorded so they are not repeated
- [x] **A vacuous assertion.** The first draft used markers `alphaMarker` / `gammaUniqueMarker`.
      The BM25 tokenizer is identifier-aware, so both yield the token `marker` and a search for one
      matched the other — the clobbering mutation passed. Markers must be token-disjoint single
      words (`zebracrossing`, `plumbago`, `quixotry`)
- [x] **A fixture that never crossed the threshold.** 3 files × 90,000 lines is 270,000 lines
      against a 200,000 flush threshold — files are appended whole before the check, so that is ONE
      flush. The multi-batch path went untested until the threshold was made overridable
- [x] **A contaminated long run.** `dist` was rebuilt mid-flight during mutation testing, and
      `runTextLineIndexing` loads the index module via a late dynamic `import` — so the running
      process could pick up mutated code. That run was discarded and re-run against a stable build
