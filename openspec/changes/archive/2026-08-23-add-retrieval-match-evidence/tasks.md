# Tasks — add-retrieval-match-evidence

## Implementation
- [x] Harden the stored contract against the 2026-08-23 implementation audit: define field-aware
      scoring without rank changes, hybrid tiers, spec/text mappings, target identity, cause
      precedence, observable budget scope, surfaced-target behavior, and concrete CLI syntax
- [x] Attribute matched-field and matched-terms data over the scorer's bounded candidates without
      duplicating the repository-wide BM25 corpus or changing its scores:
      `src/core/analyzer/unified-search.ts` (BM25 tiers, identifier-aware tokenizer from PR #221),
      `src/core/analyzer/vector-index.ts` and `spec-vector-index.ts` (dense path)
- [x] Closed field enumeration: `symbol | path | signature | doc | body | vector`; dense match →
      `field: "vector"`, empty `terms` (no fabricated lexical attribution)
- [x] Thread `matchEvidence` additively through `src/core/services/mcp-handlers/semantic.ts`
      (`search_code`, `search_specs`) and the search-derived sections of `orient.ts`
- [x] Add `openlore search <query> [--specs] [--json]`; `--explain <target>` plus discriminated
      target options calls the identical miss diagnostic from the same code
- [x] New `src/core/services/mcp-handlers/retrieval-miss.ts` — `explain_retrieval_miss`, closed
      cause set: `not-indexed`, `capability-unsupported-for-language`, `no-term-matched`,
      `filtered-out` (+ filter and value), `outranked` (+ rank and cutoff), `budget-truncated`;
      missing target → usage error
- [x] Register the tool: capability family `navigate` in `TOOL_CAPABILITY_FAMILY`, conclusion
      classification in `tool-contract.ts`, opt-in preset only (absent from the `substrate`
      default), sibling cross-references to `search_code` / `search_specs` for
      `NoRedundantConclusions`
- [x] Pi parity: assess whether the Pi extension's native tools or injection block should carry
      the evidence, per the MCP↔Pi parity invariant; state the answer either way

## Verification
- [x] Evidence equals the matcher's actual winning field and matched terms for every result across
      a fixture set covering symbol, path, signature, doc, body, and vector wins
- [x] Vector-win result carries empty `terms` and never a fabricated lexical attribution
- [x] Evidence carries no relevance, quality, or confidence value (asserted on the shape)
- [x] CLI/MCP parity: identical evidence for the same query from both faces
      (`conclusion-honesty-parity.test.ts` pattern)
- [x] One fixture per miss cause, each reported distinctly; an unindexed target reports
      `not-indexed`, never `no-term-matched`
- [x] Usage error when no target is named; no corpus-wide non-match dump exists in any code path
- [x] Non-perturbation: search goldens byte-identical before and after, apart from the additive
      `matchEvidence` key; ranking and ordering unchanged
- [x] Determinism: repeated runs on the same index state and query produce byte-identical evidence
      and diagnosis
- [x] Surface budget: `mcp-presets.test.ts` `tools/list` prefix ceiling re-measured; default
      surface size unchanged; tool-count documentation re-measured from the registry length
      (the doc-claim-sync guard)

## Spec
- [x] `mcp-handlers` delta: ADD SearchResultsCarryMatchEvidence and
      RetrievalMissesAreExplainedForANamedTarget
- [x] Cross-reference siblings in the proposal trail: `refine-search-serving-quality` owns
      `scoreKind` / prefiltering / compaction; `fix-bm25-identifier-tokenization` owns the
      tokenizer; `add-conclusion-followup-hints` owns the next call
