# Tasks — bound-standing-context-cost

## Implementation
- [x] Standing-cost measurement over each preset's exact served `tools/list` payload (including
      schemas and annotations), using a stated, version-pinned offline tokenizer approximation — no model
      call, no network
- [x] Declared per-preset budgets beside `TOOL_PRESETS`, in the same source-declared style
- [x] CI gate extending `src/cli/commands/mcp-presets.test.ts`: measured cost > declared budget
      fails, naming preset / measured / budget. Keep the existing byte-prefix ceiling as a
      secondary assertion; the token budget is the primary one
- [x] Publish the per-preset cost table in the docs; guard it with the `doc-claim-sync.test.ts`
      pattern so a stale published figure fails
- [x] Document the two delivery faces and their trade-off explicitly; state that neither is
      deprecated
- [x] CLI↔MCP conclusion-parity test: enumerate paired capabilities from the tool registry and the
      command registry, assert identical successful semantic conclusions (including boundaries,
      semantic truncation receipts, and staleness signals) for the common input projection; declare
      face-only capabilities and inputs. Transport errors and byte caps retain protocol semantics.
      Extends the `conclusion-honesty-parity.test.ts` discipline from staleness to conclusions

## Verification
- [x] Measurement is byte-stable across repeated runs on an unchanged registry; no network access
- [x] An injected description enlargement pushes a preset over budget and fails CI with the naming
      message
- [x] Budget-raise path: a raise without justification in the same change is caught in review; the
      test message states this expectation
- [x] Published table equals the measured values; a deliberately stale figure fails the guard
- [x] Parity: every paired capability agrees on common inputs before transport; a deliberately divergent
      rendering fails; an undeclared unpaired capability fails
- [x] Record the baseline measurement for every preset in the change trail, so the first budgets
      are set from data rather than guessed
- [x] Full suite green: 8,287 unit tests (2 skipped), 334 equivalence tests, 189 end-to-end tests,
      build, API consumer, MCP conformance, dependency audit, package manifest audit, lint, and
      typecheck all passed on 2026-08-23

## Spec
- [x] `mcp-quality` delta: ADD StandingSurfaceCostIsMeasuredAndBudgeted and
      BothDeliveryFacesAreFirstClassAndReachTheSameConclusion
- [x] Cross-reference: `refine-orient-context-budgeting` owns response size; this owns surface size.
      Feed the measured `substrate` vs `navigation` vs `full` numbers back to
      `add-benchmark-harness-protocol` as the cost half of the default-surface trade-off ADR-0023
      decided on accuracy evidence alone
