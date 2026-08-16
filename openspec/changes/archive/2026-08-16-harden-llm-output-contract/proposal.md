# Harden the LLM output contract: shape-check what you parse, disclose what you drop

> Status: BUILT (2026-08-16). Three verified defects on the consuming
> side of the opt-in LLM layer: the decisions pipeline parses raw completions with a
> shape-blind `parseJSON` and then dereferences fields that may not exist (a TypeError from
> a weaker model kills the whole run), a truncated response silently becomes an empty
> result (real decisions lost with only a misleading "returned 0 decisions" warning), and
> the verifier presents an LLM's self-reported accuracy score as if it were the
> deterministic metric. Schema-guard the parses, turn truncation into disclosure, and label
> LLM-judged scores with their provenance.

## The gap

- **(a) Shape-blind parsing crashes the run.** `parseJSON` (`misc.ts:10-19`) validates only
  that text parses — any shape, or the fallback. The decisions path uses raw
  `llm.complete()` + `parseJSON`, not the schema-checked `completeJSON`: the extractor
  dereferences `e.affectedFiles.length` (`extractor.ts:177`) and the consolidator passes
  `c.affectedFiles` into `resolveDomainsFromFiles` (`consolidator.ts:164`) with no shape
  guard. A syntactically-valid but field-incomplete response — plausible from weaker local
  models — throws a TypeError that kills the whole consolidation run. (Distinct from
  `harden-decision-consolidation`, which covers the spawn/CAS/status lifecycle, not
  response-shape parsing — verified no overlap.)
- **(b) Truncation silently swallowed.** Extractor and consolidator cap output at
  `DECISIONS_CONSOLIDATION_MAX_TOKENS = 2_000` (`constants.ts:617`; `extractor.ts:160`,
  `consolidator.ts:147`). A response truncated mid-array fails `parseJSON`'s regex and
  returns the `[]` fallback — real decisions silently lost. The only signal is the
  consolidator's misleading "returned 0 decisions" warning (`consolidator.ts:154-156`),
  which reads as "the LLM found nothing", not "the response was cut off". (The companion
  change `harden-llm-request-lifecycle` makes `finishReason` available/warned at the
  service; THIS change makes the parsers refuse to silently drop.)
- **(c) An LLM opinion presented as the metric.** The verifier consumes the LLM's
  self-reported `specAccuracyScore` directly as the spec-accuracy similarity
  (`verification-engine.ts:590-598`; prompt at `:522-531`) — an LLM-as-judge number
  presented undifferentiated from the deterministic checks around it. (Verified NOT covered
  by `fix-cli-conclusion-honesty` — that proposal has no verifier/accuracy mention.)

## What changes

1. **Schema-validated decision parsing.** The extractor and consolidator move to the
   `completeJSON` path or equivalent per-element shape guards: each element is checked for
   the fields the code dereferences (`title`, `rationale`, `affectedFiles` as an array, …);
   a malformed element is skipped WITH disclosure ("skipped N malformed decision entries"),
   never a TypeError, never a silent drop of the valid rest.
2. **Truncation is an error with a remedy, not an empty result.** When the response's
   `finishReason === 'length'` (or the parse fails on a response at the token cap), the
   pipeline reports "response truncated at N tokens — decisions may be lost; raise the cap
   or reduce scope" instead of returning `[]`; the misleading "returned 0 decisions"
   warning is reserved for genuinely-empty valid responses.
3. **LLM-derived scores carry provenance.** The verifier labels direct LLM judgments with
   the model id, distinguishes deterministic checks from deterministic comparisons over an
   LLM prediction, and publishes the weights and evidence basis of mixed composites. When
   no LLM score is available, deterministic keyword fallbacks are labeled as such.

## Why this is in scope

Doctrine says conclusions carry receipts and degradation is disclosed. Today the decisions
pipeline can lose recorded architectural intent to a truncated response and call it "0
decisions", and the verifier presents model opinion as measurement — both silent-degradation
defects in existing opt-in features. All fixes are deterministic guards around the LLM
boundary; no LLM is added anywhere, and the hot path is untouched.

## Impact

- Files: `src/core/decisions/extractor.ts`, `src/core/decisions/consolidator.ts` (schema
  guards + truncation disclosure), `src/utils/misc.ts` (unchanged or gains an optional
  validated variant), `src/core/verifier/verification-engine.ts` + report rendering
  (provenance labels); tests for malformed-element skip, truncation disclosure, and score
  labeling.
- Specs: `llm` — 2 ADDED requirements (StructuredOutputShapeValidation,
  TruncatedOutputIsDisclosedNotEmpty); `verifier` — 1 ADDED requirement
  (LlmJudgedScoresCarryProvenance).
- Tool surface: unchanged (no new tool; decisions/verifier are CLI+gate paths, no MCP
  payload-budget impact).
- Risk: low. Runs that previously crashed or silently emptied now degrade with disclosure;
  verifier report output gains additive provenance fields, while malformed provider model
  identifiers and provider-error completions are rejected at the trust boundary.
