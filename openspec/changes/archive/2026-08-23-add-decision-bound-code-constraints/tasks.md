# Tasks — add-decision-bound-code-constraints

## Implementation
- [x] Constraint block on the decision record: versioned, parsed in `src/core/decisions/store.ts`,
      round-tripped by `src/core/decisions/syncer.ts`; optional field on `record_decision`
- [x] Rule kinds are consumed, not defined: reuse the vocabulary in `src/core/architecture/rules.ts`
      verbatim (`widen-architecture-rule-vocabulary` owns widening it)
- [x] Lifecycle join: `src/core/architecture/check.ts` evaluates decision-sourced rules only when
      the decision is authoritative, using the shared status-transition table (PR #252); retired
      rules are reported as retired, never silently dropped
- [x] Findings carry the receipt: decision id, title, rationale, rule id, path, line. Register codes
      in `enforcement-policy.ts` with advisory defaults
- [x] Malformed-block findings: unsupported version, unknown rule kind, invalid path scope,
      duplicate rule id — each a finding, never a silent skip
- [x] Eligibility ledger in `src/core/decisions/ledger.ts`: three states, declared only, reason
      required for ineligible; no inference path exists in code (guarded by test)
- [x] Four separate measurements in `src/cli/commands/enforce.ts` and
      `src/cli/commands/decisions.ts`: adoption, coverage, unclassified count, active-rule count —
      never combined
- [x] Partial-enforcement disclosure: an eligible decision states its enforced boundary and its
      human-review remainder

## Verification
- [x] A violation's finding contains the governing decision's id, title, and rationale
- [x] Superseding a decision stops its rule from firing, with no other edit; the rule is reported
      retired
- [x] A draft / rejected decision's constraints never fire
- [x] Malformed block cases each produce their finding; none is skipped silently
- [x] Ledger: a decision with no classification counts unclassified and is never auto-assigned;
      an ineligible classification without a reason fails validation
- [x] Coverage arithmetic: an eligible decision with zero rules raises the denominator, not the
      numerator, and is listed as a gap
- [x] Report shape: the four measurements appear separately; a test asserts no combined percentage
      is emitted
- [x] No-LLM guard: a test asserts the enforcement path makes no model call, embedding lookup, or
      network request (the discipline `bm25-no-embeddings.test.ts` already establishes)
- [x] Determinism: repeated runs over unchanged bytes produce byte-identical findings and
      measurements
- [x] Whole-tree verification of every rule this repo adds to its own decisions before it is
      trusted — a rule that passes only on the diff is not certified

## Spec
- [x] `architecture` delta: ADD DecisionBoundConstraintsInheritDecisionLifecycle
- [x] `mcp-handlers` delta: ADD EnforcementEligibilityIsDeclaredAndPublishedAsSeparateMeasurements
- [x] Record the decision for this change before implementing it, and give it a constraint — the
      first entry in its own ledger
