# Tasks — bound-standing-context-cost

## Implementation
- [ ] Standing-cost measurement over each preset's full `tools/list` payload (names + descriptions
      + input schemas), using a stated, version-pinned offline tokenizer approximation — no model
      call, no network
- [ ] Declared per-preset budgets beside `TOOL_PRESETS`, in the same source-declared style
- [ ] CI gate extending `src/cli/commands/mcp-presets.test.ts`: measured cost > declared budget
      fails, naming preset / measured / budget. Keep the existing byte-prefix ceiling as a
      secondary assertion; the token budget is the primary one
- [ ] Publish the per-preset cost table in the docs; guard it with the `doc-claim-sync.test.ts`
      pattern so a stale published figure fails
- [ ] Document the two delivery faces and their trade-off explicitly; state that neither is
      deprecated
- [ ] CLI↔MCP conclusion-parity test: enumerate paired capabilities from the tool registry and the
      command registry, assert identical conclusions (including boundaries, truncation receipts,
      staleness signals) for identical inputs; an unpaired capability requires a declared reason.
      Extends the `conclusion-honesty-parity.test.ts` discipline from staleness to conclusions

## Verification
- [ ] Measurement is byte-stable across repeated runs on an unchanged registry; no network access
- [ ] An injected description enlargement pushes a preset over budget and fails CI with the naming
      message
- [ ] Budget-raise path: a raise without justification in the same change is caught in review; the
      test message states this expectation
- [ ] Published table equals the measured values; a deliberately stale figure fails the guard
- [ ] Parity: every paired capability agrees on identical inputs; a deliberately divergent
      rendering fails; an undeclared unpaired capability fails
- [ ] Record the baseline measurement for every preset in the change trail, so the first budgets
      are set from data rather than guessed
- [ ] Full suite green

## Spec
- [ ] `mcp-quality` delta: ADD StandingSurfaceCostIsMeasuredAndBudgeted and
      BothDeliveryFacesAreFirstClassAndReachTheSameConclusion
- [ ] Cross-reference: `refine-orient-context-budgeting` owns response size; this owns surface size.
      Feed the measured `substrate` vs `navigation` vs `full` numbers back to
      `add-benchmark-harness-protocol` as the cost half of the default-surface trade-off ADR-0023
      decided on accuracy evidence alone
