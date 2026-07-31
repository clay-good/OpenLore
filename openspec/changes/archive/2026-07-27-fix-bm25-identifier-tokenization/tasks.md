# Tasks — fix-bm25-identifier-tokenization

## Implementation
- [x] `tokenize()` (vector-index.ts): split camelCase / PascalCase / snake_case /
      kebab-case into sub-tokens AND retain the compound token; keep the >1-char filter; no new
      tuning constants (existing BM25 params untouched)
- [x] Tokenizer-version stamp (`VectorIndexMeta.tokenizerVersion` / `TOKENIZER_VERSION`); on skew,
      `updateFiles` defers (`deferred: 'tokenizer-changed'`) so a full rebuild re-stamps rather than
      patching a mixed-token corpus (mirrors the model-changed deferral in updateFiles). Applies to
      BM25-only indexes too. Legacy meta without the stamp is treated as v1.
- [x] Shared consumers (text-line-index.ts, spec BM25-only path) inherit the fix through the single
      shared `tokenize`. Neither persists tokens — both rebuild their corpus from raw text each
      process — so a query under the new tokenizer is uniformly re-tokenized (never mixed); no extra
      stamp needed there. The watcher surfaces `tokenizer-changed` honestly, like model-changed.
- [x] Cleanup: removed the dead RRF score accumulation; the recomputed-ranks path is the single
      score source. The merge map is now a plain candidate-union map (same set, same dense-first
      insertion order, identical final scores).

## Verification
- [x] Recall tests: `user` and `getUser` find `getUserById`; `get_user_by_id` / `get-user-by-id` /
      `GetUserById` share the same sub-token set; exact compound query ranks the exact match first
- [x] Index/query symmetry test: compound indexed under the new tokenizer found via compound and
      via each sub-token (one shared `tokenize`, exercised end-to-end over a real BM25-only index)
- [x] Skew test: index stamped under the old tokenizer (v1, and legacy-unstamped) → `updateFiles`
      returns `deferred: 'tokenizer-changed'`; same-version index still updates (no false defer)
- [x] RRF cleanup is behavior-identical (pure refactor: set + order + scoring preserved); the
      existing hybrid + BM25 search suites (70 tests) stay green
- [x] Measured index-size delta over the repo's own source (334 files): total tokens +27.4%
      (per-doc BM25 postings — the memory cost), vocabulary +0.7% (sub-tokens mostly collide with
      existing common words; IDF down-weights them). No unmeasured claims.
- [x] Full suite green

## Spec
- [x] `analyzer` delta: ADD IdentifierAwareKeywordTokenization
