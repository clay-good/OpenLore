# Tasks — add-corpus-change-intent-review

## Implementation
- [x] `src/core/drift/corpus-intent-review.ts`: closed `CORPUS_INTENT_RULES` table (source-declared,
      `FINDING_CODE_REGISTRY` style) — `corpus-normative-weakened`, `corpus-scenario-removed`,
      `corpus-requirement-removed`, `corpus-specificity-lost`, `corpus-boundary-clause-removed`,
      `corpus-decision-status-regressed`, `corpus-delta-orphaned`
- [x] Parse both revisions with the existing corpus parser (`src/core/generator/openspec-compat.ts`)
      — one parser, never a second markdown reader
- [x] Normative-keyword rank ladder as source-declared data (`SHALL`/`MUST` > `SHOULD` > `MAY` >
      none); a drop of one or more ranks fires the finding. Measurable-clause extraction is
      structural (number+unit, enumerated set, named threshold), never a similarity model
- [x] Continuity matching: exact requirement name, then identical scenario set; no match →
      report removal, never assert a rename
- [x] Read-only revision materialization in `src/core/drift/git-diff.ts`: no `git worktree`, no
      checkout, no index/`HEAD` mutation; path args through `gitPathArgs()` (PR #249)
- [x] Verdict object: `review-recommended | no-review-needed` plus the reason findings. No score,
      no weighting, no confidence value
- [x] `src/cli/commands/review-corpus.ts`: human + JSON modes, JSON to stdout / diagnostics to
      stderr, base-ref resolution disclosed via the existing `resolveBaseRefDisclosed` discipline
      (PR #243)
- [x] Register the finding codes in `enforcement-policy.ts` with advisory defaults; wire the review
      as a finding source in `src/cli/commands/enforce.ts`
- [x] Rule-table-closure guard test: a rule with no registered code, or referencing a corpus field
      the parser does not produce, fails CI

## Verification
- [x] One fixture pair per rule: fires on the weakening edit, silent on the equivalent-strength
      edit
- [x] `SHALL` → `SHOULD` fires even when the head requirement passes structural validation
- [x] Scenario deletion fires when a requirement drops from three scenarios to one
- [x] Rename: an exact-name and an identical-scenario-set rename each produce no removal finding;
      an unmatched disappearance produces exactly one removal finding and asserts no rename
- [x] Byte-identical corpora → zero findings, `no-review-needed`
- [x] Non-mutation: `git status`, index, and `HEAD` are byte-identical before and after a run with
      a dirty working tree; two concurrent runs produce identical output
- [x] Determinism: repeated runs on the same ref pair produce byte-identical JSON; no timestamp
      appears in the compared payload
- [x] Exit codes: advisory-only → 0; a policy-promoted blocking finding → non-zero; unresolvable
      base ref → disclosed, never silently substituted
- [x] Dogfood: run against this repository's own last corpus-repair range and confirm the pass
      surfaces the regression class `STATUS.md` records was found by hand

## Spec
- [x] `drift` delta: ADD CorpusIntentDeltaIsReviewedBetweenRefs
- [x] `cli` delta: ADD ReviewCorpusCommandContract
- [x] Cross-reference the boundaries in the proposal trail: spec→code is `check_spec_drift`;
      corpus-as-it-stands is `add-knowledge-corpus-integrity`; changed production symbols is
      `briefing_since`
