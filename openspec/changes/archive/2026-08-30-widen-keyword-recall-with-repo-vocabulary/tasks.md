# Tasks — widen-keyword-recall-with-repo-vocabulary

## Implementation

- [x] `src/core/analyzer/repo-vocabulary.ts`: mine the lexicon from Pass-1 material already
      resident — identifiers, doc comments, literal keys, file paths:
  - [x] abbreviation links (AMAP-style): short is a subsequence of long AND the two co-occur in a
        recognized binding position (declaration↔doc comment, parameter↔type name,
        variable↔assigned-from function)
  - [x] co-occurrence links from tokens sharing a symbol name, its doc comment, or its immediate
        call neighborhood (the graph-aware half)
  - [x] conservative English suffix families (`-s`, `-ing`, `-ed`, `-er`, `-tion`), recorded only
        when both forms are attested in-repo
  - [x] a small, source-declared seed set of universal programming abbreviations; everything else
        must be evidenced
- [x] Persist the lexicon as a version-stamped sidecar next to the BM25 corpus, atomic write,
      stable ordering; reuse the tokenizer-version mismatch discipline (ignore-and-rebuild)
- [x] **Two-tier ranking, NOT a weight multiplier** (a scalar weight provably cannot guarantee
      the invariant — `bm25Score` sums over terms without bound): compute originalScore and
      expansionScore separately, order by `(originalScore>0) desc, originalScore desc,
      expansionScore desc, id asc`, and apply it BEFORE candidate truncation (`limit*5`/`limit*3`)
      and BEFORE RRF (`vector-index.ts:1009-1018` fuses RANKS and discards magnitudes)
- [x] Apply at ALL tokenizer-sharing query paths incl. `text-line-index.ts:257` (the `search_code`
      text fallback — exactly the under-recall case) or enumerate the exclusions with reasons
- [x] Return the applied expansion set with results; thread it through `search_code`,
      `search_specs`, and `orient`
- [x] Extend the served-mode vocabulary — owner is `src/core/analyzer/embedder.ts:17` +
      `servedRetrievalMode` (`:87-96`), NOT semantic.ts. Six live `retrievalMode === 'keyword'`
      equality checks must become family tests (`semantic.ts:207`, `:293`, `:539`, `:551`,
      `orient.ts:206`, `:860`) or the flip silently sets `searchMode:'hybrid'` (false — the scale
      is still unbounded BM25) and DROPS the `embed --local` hint the spec requires to remain
- [x] Bucketed-join candidate generation (first char + length band); 4 mining guards (len≥3,
      first-char anchor, ≤3× length, ≥2 binding sites); both forms must be in the corpus df table
- [x] Content stamp (not just version stamp) on the lexicon; invalidate it wherever
      `patchBm25Cache` deletes the corpus sidecar (`vector-index.ts:277`)
- [x] Register the config flag in `CONFIG_FIELD_KINDS` (`config-schema.ts:40`) — the
      `Record<keyof OpenLoreConfig, …>` binding fails compilation otherwise
- [x] MCP ↔ Pi parity (CLAUDE.md): `orient`/`search_code` output shape changes → mirror in
      `src/pi/extension.ts` or record the skip (no Pi source change: Pi delegates these calls to
      the same MCP handlers and returns their response shape unchanged)
- [x] Config flag to disable expansion (documented in `docs/configuration.md`)
- [x] `openlore prove --estimate`: add a retrieval-recall comparison over the repository's own
      symbol ↔ doc-comment pairs, labeled `estimate`, so the gain is measured on the user's repo

## Verification

- [x] Mining tests: an evidenced abbreviation is linked; an unevidenced one is not; a non-English
      token is never stemmed; the seed set is the only unevidenced source
- [x] Determinism: two analyses produce byte-identical lexicons; the analyze-twice byte-diff e2e
      still passes
- [x] Stale-stamp test: a lexicon under an old stamp is ignored and rebuilt, never served
- [x] Ranking-safety test: exact-identifier queries rank the exact match first with expansion on;
      plus an eviction test (expansion-only matches must not push an original match out of the
      truncated candidate window)
- [x] Disabled-expansion test: ranking byte-identical to the pre-change ranking, no re-index
- [x] Recall test: a natural-language task query matches the abbreviated symbol it describes, and
      the response names the expansion terms responsible
- [x] Index-invariance test: enabling/disabling expansion changes neither corpus bytes nor corpus
      size
- [x] Disclosure test: mode is `keyword` with an empty lexicon and `keyword+vocabulary` with a
      populated one; the semantic upgrade hint is unchanged in both
- [x] Benchmark: report retrieval recall@k on symbol ↔ doc-comment pairs before/after. Measured on
      this repository: recall@10 was 63.00% → 63.00% across 100/1,099 deterministic pairs
      (0.00 percentage-point change). Do **NOT**
      re-run the agent cost benchmark against the published loss case —
      `AGENT-BENCHMARKS.md:139-166` establishes that loss is round-trip-forced, not recall-bound,
      and recording expansion against it would be a claim the benchmark cannot support
- [x] Ranking-invariant test built as a COUNTEREXAMPLE search: one weak original match vs. max
      expansion terms at high idf/tf — the original must win
- [x] Mining-cost test: bucketed generation stays within the declared budget; assert the naive
      all-pairs path is not taken
- [x] Full suite green; docs updated (`providers.md`, `configuration.md`) (9,096 passed in the
      full run; the sole concurrent-store timeout passed all 24 tests on immediate isolated rerun)
