# Tasks — widen-keyword-recall-with-repo-vocabulary

## Implementation

- [ ] `src/core/analyzer/repo-vocabulary.ts`: mine the lexicon from Pass-1 material already
      resident — identifiers, doc comments, literal keys, file paths:
  - [ ] abbreviation links (AMAP-style): short is a subsequence of long AND the two co-occur in a
        recognized binding position (declaration↔doc comment, parameter↔type name,
        variable↔assigned-from function)
  - [ ] co-occurrence links from tokens sharing a symbol name, its doc comment, or its immediate
        call neighborhood (the graph-aware half)
  - [ ] conservative English suffix families (`-s`, `-ing`, `-ed`, `-er`, `-tion`), recorded only
        when both forms are attested in-repo
  - [ ] a small, source-declared seed set of universal programming abbreviations; everything else
        must be evidenced
- [ ] Persist the lexicon as a version-stamped sidecar next to the BM25 corpus, atomic write,
      stable ordering; reuse the tokenizer-version mismatch discipline (ignore-and-rebuild)
- [ ] Query-side expansion in the BM25 query paths (`vector-index.ts`, `spec-vector-index.ts`):
      bounded terms per original token, expansion terms scored at a lower weight than originals;
      the index is never expanded and never rebuilt for this
- [ ] Return the applied expansion set with results; thread it through `search_code`,
      `search_specs`, and `orient`
- [ ] Extend the served-mode vocabulary (`mcp-handlers/semantic.ts:206-207`, `:292-293`,
      `:538-539`) to distinguish keyword from keyword+vocabulary; keep both existing semantic
      upgrade hints verbatim
- [ ] Config flag to disable expansion (documented in `docs/configuration.md`)
- [ ] `openlore prove --estimate`: add a retrieval-recall comparison over the repository's own
      symbol ↔ doc-comment pairs, labeled `estimate`, so the gain is measured on the user's repo

## Verification

- [ ] Mining tests: an evidenced abbreviation is linked; an unevidenced one is not; a non-English
      token is never stemmed; the seed set is the only unevidenced source
- [ ] Determinism: two analyses produce byte-identical lexicons; the analyze-twice byte-diff e2e
      still passes
- [ ] Stale-stamp test: a lexicon under an old stamp is ignored and rebuilt, never served
- [ ] Ranking-safety test: for a corpus of exact-identifier queries, the exact match ranks first
      with expansion on — no regression versus expansion off
- [ ] Disabled-expansion test: ranking byte-identical to the pre-change ranking, no re-index
- [ ] Recall test: a natural-language task query matches the abbreviated symbol it describes, and
      the response names the expansion terms responsible
- [ ] Index-invariance test: enabling/disabling expansion changes neither corpus bytes nor corpus
      size
- [ ] Disclosure test: mode is `keyword` with an empty lexicon and `keyword+vocabulary` with a
      populated one; the semantic upgrade hint is unchanged in both
- [ ] Benchmark: re-run the `orient` retrieval benchmark on the published loss-case repos and
      record the measured delta (wins and losses) in `docs/AGENT-BENCHMARKS.md`
- [ ] Full suite green; docs updated (`providers.md`, `configuration.md`)
