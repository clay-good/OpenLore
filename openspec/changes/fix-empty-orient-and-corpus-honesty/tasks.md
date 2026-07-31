# Tasks — fix-empty-orient-and-corpus-honesty

## Implementation

- [ ] Corpus membership: exclude `external::`-namespaced (and other synthetic) nodes when
      building the BM25/vector function corpus (`vector-index.ts`); align the "Function index
      built (N functions)" message with the call-graph count
- [ ] Empty-result disclosure in `handleOrient`: tokenize the task with the existing
      identifier-aware tokenizer; for tokens with no posting, do a bounded prefix/substring
      scan over the corpus vocabulary for near-token receipts; attach `emptyResult`
- [ ] Conditional `nextSteps`: branch on result shape; empty → search_code/get_map/near-token
      guidance, drop decision-workflow boilerplate
- [ ] Pi parity check: empty-orient contract through the Pi surface; note if intentionally
      skipped
- [ ] Tests: `greeting`→`greet` near-token fixture; foreign-query no-fabrication; corpus
      excludes `external::` (count parity asserted against call graph); nextSteps branch;
      corpus rebuild from persisted sidecar keeps the exclusion (tokenizer-stamp path)

## Verification

- [ ] Sandbox repro: 5-function repo reports 5 indexed functions; "change the greeting" returns
      the disclosure naming `greet`; empty result carries no record_decision advice
