# Tasks — persist-tokenized-keyword-corpus

## Implementation
- [x] Shared corpus (de)serializer beside `buildBm25Corpus` (vector-index.ts): `Bm25Corpus` ⇄ a
      plain JSON shape (`tfMap`/`df` `Map`s → arrays and back), deterministic. The serialized form
      carries `tokenizerVersion` (= `TOKENIZER_VERSION`) and a corpus `schemaVersion` (=1) format
      stamp. No new tuning constants.
- [x] Write the sidecar (`bm25-corpus.json` inside the index folder, keyed off `dbPath`) in
      `VectorIndex.build` after the table + meta write, in BOTH the BM25-only and embedded branches.
      Build always overwrites it; `persistCorpusSidecar` is best-effort (a write failure just means
      the next cold start rebuilds).
- [x] Load-or-rebuild at the two cold paths (hybrid + `_bm25Only`) via one shared
      `loadOrBuildBm25Corpus(dbPath, allRows)`: if the sidecar parses AND its `tokenizerVersion` ===
      `TOKENIZER_VERSION` AND `N` matches the row count → hydrate (no document re-tokenized); else
      rebuild from raw text and re-persist. Missing / corrupt / mismatched all fall back to rebuild —
      never a hard failure, never a served stale corpus.
- [x] Invalidate on incremental patch: `patchBm25Cache` deletes the sidecar (before its early
      return, so invalidation happens even with no in-memory corpus cached). No per-batch re-serialize
      (that perf refinement belongs to `optimize-serving-hot-path-caches`).

## Verification
- [x] Hydrate test: build, drop `_bm25Cache`, search → hits; a marker token present ONLY in the
      sidecar (never in raw text) matches, proving the hydrate path was taken, not a rebuild.
- [x] Skew test: sidecar `tokenizerVersion` set older → sidecar ignored, corpus rebuilt from raw
      text, results correct, sidecar re-stamped to `TOKENIZER_VERSION` (marker dropped).
- [x] Degrade tests: missing sidecar (legacy index) and a corrupt/unparseable sidecar both rebuild
      from raw text with no throw, and re-persist a valid sidecar.
- [x] Patch-invalidation test: build (sidecar present) → incremental `updateFiles` → sidecar gone.
- [x] Round-trip equivalence: hydrated search returns the identical ordered ids AND scores as a
      forced rebuild for the same query; plus a defensive N-mismatch test (lie about corpus size →
      ignored → rebuild).
- [x] Measured on the repo's own source (334 docs, representative corpus): cold-start corpus load
      **145.5 ms rebuild → 13.3 ms hydrate (91% faster, ~132 ms saved)**; sidecar **1.78 MB**.
      Disclosed: the LanceDB row read is unchanged — the win is tokenization/corpus-build CPU.
- [x] Full suite green (lint, typecheck, test:run, build).

## Spec
- [x] `analyzer` delta: ADD PersistedKeywordCorpusGuardedByTokenizerStamp.

## Deferred (disclosed, not in this PR)
- Text-line (`text-line-index.ts:248`) and spec (`spec-vector-index.ts:518-521`) keyword corpora:
  same shared serializer, mechanical follow-up.
- Column projection excluding `vector`, top-k early termination, incremental df patching, and
  external-analyze mtime/attestation invalidation: owned by `optimize-serving-hot-path-caches`.
