# Tasks — harden-grammar-load-disclosure

## Implementation
- [x] Route the 8 core getters (call-graph.ts:179-333) through loadGrammarSoft-equivalent:
      warn once with an actionable message, cache the null, keep the file search-indexed
- [x] Guard _NativeQuery construction (:613-614 and the other 20 sites) so a grammar-version
      node-type mismatch degrades to the same disclosed boundary, not the silent parse catch
- [x] Record language-grammar-unavailable as a distinct boundary in the parse-health /
      analysis-result surface (sibling to add-parse-health-boundary-disclosure)
- [x] language-support.ts: add per-language grammarStatus (loaded|unavailable|untried) from
      the runtime handle cache; get_language_support reports it alongside static capability

## Verification
- [x] Missing-grammar test: with tree-sitter-typescript absent, analyze emits ONE
      "grammar unavailable" warning + boundary, TS files reach the search index, and the
      result is not a silent empty graph
- [x] get_language_support test: same condition reports callGraph capability with
      grammarStatus:unavailable, not a bare "supported"
- [x] Version-drift test: a query construction failure degrades to the disclosed boundary
- [x] Full suite green

## Spec
- [x] `analyzer` delta: ADD CoreGrammarLoadFailureIsDisclosed,
      CapabilityMatrixReflectsRuntimeGrammarAvailability
