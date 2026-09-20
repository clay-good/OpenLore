# Tasks

## 1. Verdict derivation

- [x] 1.1 Add the coverage-verdict fold over `MatchEvidence` in
  `src/core/analyzer/retrieval-evidence.ts` (`covered` / `weak` / `uncovered` from field and tier
  alone); verify with unit tests covering a strong-field hit, an all-body-text set, and an empty set
- [x] 1.2 Verify by test that the fold takes no threshold or configuration input and is a total
  function of the evidence on the rows

## 2. Question kinds

- [x] 2.1 Define the closed question-kind vocabulary and the kind→tool map, with `what-gates` mapped
  to no tool; verify a contract test rejects an unlisted kind
- [x] 2.2 Accept an optional question kind on the retrieval handlers, defaulting to `where-is`, and
  verify fixed-kind handlers supply their own

## 3. Handler integration

- [x] 3.1 Carry the verdict on `search_code` and `search_specs` responses and verify the structured
  output contains it in all three verdict states
- [x] 3.2 Withhold the ranked list on `uncovered`, returning reason, question kind and the miss
  explainer pointer; verify no rows are returned in that state
- [x] 3.3 Suppress orient's symbol list and insertion points on `uncovered` while still returning
  specs, decisions and staleness; verify with a task description matching nothing
- [x] 3.4 Make `suggest_insertion_points` abstain on `uncovered` and verify it recommends nothing
- [x] 3.5 Add the verdict to the conclusion shape in `tool-contract.ts` and verify a handler omitting
  it fails the dispatch-time check

## 4. Verification

- [x] 4.1 Reproduce the 2026-09-20 case as a fixture — a task description about interface behavior
  with no matching symbols — and verify the response abstains and names `what-gates` as unserved
- [x] 4.2 Verify every existing retrieval test that asserted a non-empty list still passes under a
  `covered` verdict, and update only those whose fixture was noise
- [x] 4.3 Run `openspec validate --strict` for this change and the reaching tests from
  `openlore select-tests`; verify both are green
