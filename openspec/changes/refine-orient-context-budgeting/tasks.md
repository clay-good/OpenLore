# Tasks — refine orient context budgeting

## Implementation
- [x] Build the top-`limit` answer exactly as without a budget; scope file-scoped sections to its files
- [x] Extend: add functions ranked past `limit` (with call paths) from a 60-entry pool while they fit
- [x] Trim: drop whole lowest-ranked entries peripheral-first with the fewest removals; call paths stay
      with their functions; governance, architecture violations, matching specs never dropped
- [x] Measure the response as sent (pretty JSON, staleness note, receipt); exact `estimatedTokens`
- [x] Reject non-finite or sub-1 budgets; CLI human output shows the receipt
- [ ] ~~Cold-start expansion multiplier; seed-quality weighting~~ — deferred (see proposal)
- [ ] ~~Same budgeting path for `get_minimal_context`~~ — deferred (see proposal)

## Verification
- [x] Helper tests: fewest removals against a brute-force oracle, a non-monotone case, measured
      rendering, minimum and unnamed sections, determinism
- [x] Orient tests: no budget unchanged; a covering budget keeps every default section and adds functions;
      a small budget trims peripheral first with exact receipts; collapsed duplicates keep one call path;
      governance kept under an unmeetable budget; invalid budgets rejected; determinism
- [x] Full suite green
