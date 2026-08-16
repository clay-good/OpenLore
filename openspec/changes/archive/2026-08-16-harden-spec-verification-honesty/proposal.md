# Harden spec-verification honesty: no silent decision loss, no shrinking denominator, no fabricated requirement claims

> Status: IMPLEMENTED (2026-08-16). The verification layer previously fabricated claims and
> silently lost data: the decisions persist step dropped any consolidated decision the LLM forgot to
> mention (and marks its draft human-'rejected'), the verification report's denominator shrinks
> to whatever didn't fail, and requirement-level "implemented / not implemented" claims are
> synthesized positionally from a scalar score. Extends `harden-llm-output-contract` (pass 3) —
> that change covers shape-blind parse crashes and truncation-to-`[]`; these three defects
> survive it intact because they occur AFTER a well-formed response parses cleanly. Its files are
> not modified here.

## Why

- **(a) The persist step silently discards unmentioned decisions — and brands their drafts
  human-'rejected'.** `verifyDecisions` returns only the decisions the LLM listed under
  `verified` or `phantom` (`src/core/decisions/verifier.ts:169-190` — no partition invariant
  over the input id set). `src/cli/commands/decisions.ts` then patches EVERY original draft to
  `status: 'rejected'` (`:671-673`, over `originalDraftIds` built at `:648`) and writes back only
  `[...verified, ...phantom]` (`:658`, `:674`). An LLM that mentions 4 of 5 decisions — routine,
  well-formed JSON, no guard fires — permanently loses decision 5's architectural intent, and
  its draft carries `'rejected'`, the status reserved for an explicit human verdict, which
  `INACTIVE_STATUSES` (`src/core/decisions/store.ts:168-170`) then hides from recall, orient,
  and projection. The loss is invisible at every later layer.
- **(b) The report's denominator silently shrinks.** Per-candidate failures are caught, logged
  at warning, and dropped from `results`
  (`src/core/verifier/verification-engine.ts:244-249`); `overallConfidence` averages over
  `results.length` (`:941-944`), `sampledFiles` reports only successes (`:1022`), and the
  `recommendation` derives from that average (`:1010-1017`). 12 candidates with 9 rate-limited →
  the report says "Files Verified: 3", can read `'ready'`, and gives zero indication that 75%
  of the sample was never checked.
- **(c) Requirement-level claims fabricated from a scalar.** With an LLM score present,
  `analyzeRequirementCoverage` synthesizes `actuallyImplements` positionally
  (`verification-engine.ts:834-841`):
  `relatedRequirements.slice(0, Math.round(llmScore * requirements.length))` — the
  "implemented" set is decided by order of appearance, not by any assessment. `generateFeedback`
  then emits NAMED claims from it (`:923-927`: "Requirements X, Y don't appear to be
  implemented"). The keyword fallback path (`:847-863`) does evidence each requirement; the LLM
  path invents membership.
- **Verified minor, folded in:** the report timestamp is `toLocaleString()`
  (`verification-engine.ts:1020`) — locale-dependent where sibling artifacts use ISO.

## What Changes

1. **Partition invariant on decisions verification.** `verified ∪ phantom` (plus an explicit
   `unassessed` remainder) MUST cover the input id set: any input decision the LLM response does
   not mention is retained — its draft status unchanged — and disclosed as unassessed in the
   command output. A draft is patched to `'rejected'` only when its replacement was actually
   persisted (or a human rejected it); `'rejected'` stops being a side effect of LLM omission.
2. **Honest denominator.** `VerificationReport` gains attempted/failed counts (with per-file
   failure reasons); `overallConfidence` and `sampledFiles` are labeled as computed over
   successes; the `recommendation` is withheld — or explicitly qualified — when failures exceed
   a disclosed fraction of the sample, instead of silently grading on the survivors.
3. **No positional fabrication.** In the LLM-scored path, report the scalar coverage with its
   provenance and NO per-requirement membership; named "requirement X not implemented" feedback
   is emitted only from the path that actually evidences each requirement (the keyword matcher,
   or a future per-requirement assessment). The positional `slice` is deleted.
4. Minor: report timestamp moves to ISO (`toISOString()`), matching sibling artifacts.

Boundary with `harden-llm-output-contract`: that change guards the parse (shape, truncation) and
labels the LLM score's provenance at its consumption site (`verification-engine.ts:590-598`);
this change guards what the pipeline DOES with a cleanly parsed response — persistence
completeness, report denominators, and claims synthesized downstream of the score.

## Scope rationale

The substrate's contract (decision `c6d1ad07`) is deterministic conclusions with honest
boundaries; the verification layer is the one place LLM output feeds durable stores and human
verdicts, so its honesty discipline must be strictest. (a) destroys recorded architectural
memory — the exact asset OpenLore exists to preserve — on an unobservable trigger; (b) is the
denominator analogue of silent truncation (a conclusion resting on unchecked input, no
receipt); (c) presents invented per-requirement findings as if assessed. All three fixes are
disclosure and invariants — no new LLM calls, no new analysis, nothing blocking.

## Impact

- Files: `src/core/decisions/verifier.ts` (partition of input ids → verified/phantom/unassessed),
  `src/cli/commands/decisions.ts` (persist step retains unassessed drafts; reject only on
  persisted replacement or human verdict), `src/core/verifier/verification-engine.ts`
  (report fields, qualified recommendation, delete the positional slice, ISO timestamp); tests
  alongside each.
- Specs: `llm` — 1 ADDED requirement (DecisionsVerificationPersistenceIsPartitionSafe);
  `verifier` — 2 ADDED requirements (VerificationReportDisclosesItsDenominator,
  RequirementClaimsRequireEvidence).
- Risks: `VerificationReport` gains fields (additive); feedback loses the named-requirements
  line in the LLM path (intended — it was fabricated); an `unassessed` remainder means a
  consolidation run can now end with drafts still pending, which the decisions gate already
  handles (`drafts_pending_consolidation`). Report timestamp format change is visible to anyone
  parsing the old locale string (none known in-repo).
