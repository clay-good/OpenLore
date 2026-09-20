# Proposal

## Why

"Is this tested?" is answered today by reachability: `select_tests` and the coverage tools report
that a test's call graph reaches a symbol. That is the right *selection* answer — it tells you what
to run — but it is routinely read as an *evidence* answer, and it is not one. A test that reaches a
function through six layers and asserts on something else entirely produces the same verdict as a
test that calls it and checks its result. `report_coverage_gaps` is already careful to say only "no
reaching test" and never "tested", precisely because the substrate cannot currently tell the
difference. The missing piece is the positive direction: when a test does reach a symbol, say what
kind of evidence that is.

## What Changes

- Test-to-symbol relationships gain a **classification**, computed statically: `asserts-on` (an
  assertion in the test body takes a value derived from a call to the symbol), `exercises` (the test
  calls the symbol but no assertion consumes its result), and `reaches` (the symbol is only in the
  test's transitive call graph).
- The classification is derived from the assertion call sites and the local data flow between the
  symbol's call and the assertion's argument within the test body — no test execution, no coverage
  instrumentation, no mutation.
- `verify_claim` gains a `tested` kind: the subject is a symbol, and the verdict cites the strongest
  relationship found, naming the test file, the test name and the assertion line. A symbol reached
  only transitively is `unverifiable` for this claim, never `confirmed`.
- The classification is a **sound lower bound in one direction only**: `asserts-on` means an
  assertion consumed the symbol's output, not that its behavior is fully specified. Nothing in this
  change licenses the word "tested" as a guarantee, and the spec states that limit.
- Assertion recognition is per test framework and declared: an unrecognized framework yields
  `reaches`, with its reason disclosed, never a downgrade presented as absence of testing.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `analyzer`: the test-to-symbol relationship gains a statically-derived evidence classification
  alongside the existing reachability, with declared framework support.
- `mcp-handlers`: `verify_claim` gains the `tested` kind, with the same receipt discipline as the
  existing structural kinds.

## Impact

- `src/core/analyzer/` — assertion-site collection and the local data-flow check inside test bodies,
  reusing the existing CFG/def-use overlay rather than adding an analysis
- `src/core/services/mcp-handlers/claim-verification.ts` — the `tested` kind beside `calls`,
  `reaches`, `dead`, `impacts`, `safe-to-change`, `decision-current`
- `select_tests` and the coverage-gap report — carry the classification where they already carry a
  reason; neither changes its selection behavior
- `docs/language-support.md` — declared framework support for assertion recognition
- Explicitly out of scope: mutation probing. See `design.md` — it is the only way to prove an
  assertion would catch a change, and it requires running the suite, which this change does not do
