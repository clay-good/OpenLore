# Tasks — add-retrieval-match-evidence

## Implementation
- [ ] Return the matched-field and matched-terms data the scorer already computes:
      `src/core/analyzer/unified-search.ts` (BM25 tiers, identifier-aware tokenizer from PR #221),
      `src/core/analyzer/vector-index.ts` and `spec-vector-index.ts` (dense path)
- [ ] Closed field enumeration: `symbol | path | signature | doc | body | vector`; dense match →
      `field: "vector"`, empty `terms` (no fabricated lexical attribution)
- [ ] Thread `matchEvidence` additively through `src/core/services/mcp-handlers/semantic.ts`
      (`search_code`, `search_specs`) and the search-derived sections of `orient.ts`
- [ ] `--explain` on the CLI search path emitting the identical evidence object from the same code
- [ ] New `src/core/services/mcp-handlers/retrieval-miss.ts` — `explain_retrieval_miss`, closed
      cause set: `not-indexed`, `capability-unsupported-for-language`, `no-term-matched`,
      `filtered-out` (+ filter and value), `outranked` (+ rank and cutoff), `budget-truncated`;
      missing target → usage error
- [ ] Register the tool: capability family `navigate` in `TOOL_CAPABILITY_FAMILY`, conclusion
      classification in `tool-contract.ts`, opt-in preset only (absent from the `substrate`
      default), sibling cross-references to `search_code` / `search_specs` for
      `NoRedundantConclusions`
- [ ] Pi parity: assess whether the Pi extension's native tools or injection block should carry
      the evidence, per the MCP↔Pi parity invariant; state the answer either way

## Verification
- [ ] Evidence equals the matcher's actual winning field and matched terms for every result across
      a fixture set covering symbol, path, signature, doc, body, and vector wins
- [ ] Vector-win result carries empty `terms` and never a fabricated lexical attribution
- [ ] Evidence carries no relevance, quality, or confidence value (asserted on the shape)
- [ ] CLI/MCP parity: identical evidence for the same query from both faces
      (`conclusion-honesty-parity.test.ts` pattern)
- [ ] One fixture per miss cause, each reported distinctly; an unindexed target reports
      `not-indexed`, never `no-term-matched`
- [ ] Usage error when no target is named; no corpus-wide non-match dump exists in any code path
- [ ] Non-perturbation: search goldens byte-identical before and after, apart from the additive
      `matchEvidence` key; ranking and ordering unchanged
- [ ] Determinism: repeated runs on the same index state and query produce byte-identical evidence
      and diagnosis
- [ ] Surface budget: `mcp-presets.test.ts` `tools/list` prefix ceiling re-measured; default
      surface size unchanged; tool-count documentation re-measured from the registry length
      (the doc-claim-sync guard)

## Spec
- [ ] `mcp-handlers` delta: ADD SearchResultsCarryMatchEvidence and
      RetrievalMissesAreExplainedForANamedTarget
- [ ] Cross-reference siblings in the proposal trail: `refine-search-serving-quality` owns
      `scoreKind` / prefiltering / compaction; `fix-bm25-identifier-tokenization` owns the
      tokenizer; `add-conclusion-followup-hints` owns the next call
