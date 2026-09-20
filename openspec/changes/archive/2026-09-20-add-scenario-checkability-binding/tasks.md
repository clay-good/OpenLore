# Tasks — add-scenario-checkability-binding

## Implementation
- [x] Checkability grammar: WHEN/GIVEN+WHEN condition present, THEN present, THEN names an
      observable subject from a closed token-class list (quoted literal, tool/command, symbol,
      field, numeric/comparative outcome); implemented in the corpus-lint lane
- [x] Register `scenario-unverifiable-shape` advisory finding (failing clause quoted)
- [x] `audit_spec_coverage`: per-scenario labels `verification-path-exists` (reaching tests
      named) / `no-reaching-test` / `not-assessable` (anchor reason), composing the existing
      backward test reachability over the requirement's resolved symbol anchor
- [x] Sound-direction sentence ("a path exists ≠ the scenario is asserted") verbatim in both
      the finding description and the coverage response

## Verification
- [x] Lint fixtures: well-shaped scenario passes; missing WHEN, missing THEN, and
      unobservable THEN ("it works well") each fail with the clause quoted
- [x] Binding fixtures: anchored requirement with a reaching test → path-exists + test named;
      anchored with none → no-reaching-test; unanchored → not-assessable + reason
- [x] Lint never blocks by default; policy opt-in path exercised
- [x] Full suite green

## Spec
- [x] `openspec` delta: ADD ScenariosAreLintedForCheckableShape
- [x] `mcp-handlers` delta: ADD ScenarioVerificationPathsAreComputedAndBounded
