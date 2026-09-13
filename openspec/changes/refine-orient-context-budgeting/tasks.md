# Tasks — refine orient context budgeting

## Implementation
- [x] Whole-payload fit for `orient`: binary search over whole-entry removals in a fixed
      peripheral-first section order until the rendered payload fits `tokenBudget`; no-budget default
      unchanged
- [x] Widen the relevant-function and call-path pool when a budget is set (bounded at 60)
- [ ] ~~Cold-start expansion multiplier~~ — deferred (see proposal)
- [ ] ~~Seed-quality preference beyond the task match~~ — deferred (see proposal)
- [x] Peripheral-first truncation with a `budget` receipt (per-section omitted counts, estimated
      tokens, fits); governance context never trimmed
- [ ] ~~Same budgeting path for `get_minimal_context`~~ — deferred (see proposal)

## Verification
- [x] Helper tests: unchanged when it fits, peripheral drained first, fewest removals, minimum and
      unnamed sections respected, determinism
- [x] Orient tests: no budget unchanged, small budget fits with receipt, large budget broadens past the
      entry cap, governance kept under an unmeetable budget, determinism
- [x] Full suite green
