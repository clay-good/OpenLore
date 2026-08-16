# Tasks — harden-llm-output-contract

## Implementation
- [x] Extractor (extractor.ts:164, :177): shape-guard each parsed element before use (title,
      rationale, affectedFiles is an array, …) — skip malformed elements with a counted
      disclosure, keep the valid rest; no raw `e.affectedFiles.length` on unchecked data
- [x] Consolidator (consolidator.ts:152, :164): same per-element guards before
      `resolveDomainsFromFiles(c.affectedFiles, …)`; prefer the `completeJSON` schema path
      where the response format allows
- [x] Truncation: check `finishReason === 'length'` on the extractor/consolidator responses
      (cap = DECISIONS_CONSOLIDATION_MAX_TOKENS, constants.ts:617; extractor.ts:160,
      consolidator.ts:147) → explicit "truncated at N tokens, decisions may be lost — raise
      the cap or reduce scope" error/disclosure, never a silent `[]`
- [x] Rescope the "returned 0 decisions" warning (consolidator.ts:154-156) to
      genuinely-empty, well-formed responses only
- [x] Verifier (verification-engine.ts:590-598, prompt :522-531): tag the similarity score's
      provenance (`llm-judged` + model id vs `keyword-fallback`) through PurposeMatch into
      report output; keep deterministic sub-checks separately attributed, no blended number

## Verification
- [x] Test: a syntactically-valid, field-incomplete extractor/consolidator response (e.g.
      element missing `affectedFiles`) skips that element with disclosure — no TypeError,
      valid siblings survive
- [x] Test: a mid-array-truncated response with `finishReason: 'length'` produces the
      truncation error/disclosure, not an empty result and not "returned 0 decisions"
- [x] Test: a genuinely-empty valid response still warns "returned 0 decisions"
- [x] Test: verifier report labels an LLM-supplied score `llm-judged` with model id, and the
      fallback path `keyword-fallback`; deterministic sub-checks remain separate fields
- [x] Confirm no overlap with harden-decision-consolidation (spawn/CAS/status paths
      untouched by this change)
- [x] Full suite green

## Spec
- [x] `llm` delta: ADD StructuredOutputShapeValidation, TruncatedOutputIsDisclosedNotEmpty
- [x] `verifier` delta: ADD LlmJudgedScoresCarryProvenance
