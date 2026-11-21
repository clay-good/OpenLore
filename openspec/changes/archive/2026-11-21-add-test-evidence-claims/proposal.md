# Say what kind of test evidence a symbol has

> Priority: P2 · Not built
> Reaches the agent through: `verify_claim` (new `tested` kind), `blast_radius` and `verify_change` (evidence class on the tests to run), and the before-stop moment
> Why it helps the agent: before it says "this is tested," the agent knows if a test asserts on the symbol, only calls it, or only reaches it.

## Problem

"Is this tested?" is answered today by reachability. `select_tests` reports that a test's call
graph reaches a symbol. That is the right answer to "what do I run," but the agent reads it as
"this is verified." A test that reaches a function through six layers and asserts on something
else gets the same answer as a test that calls it and checks the result. `verify_claim` has no
kind for this claim, so the agent states it without proof.

## What changes

- **Three evidence classes**, computed statically for each test-to-symbol relationship:
  `asserts-on` (an assertion argument is derived from a call to the symbol, inside that test),
  `exercises` (the test calls the symbol, no assertion uses the result), `reaches` (the symbol is
  only in the test's transitive call graph). Order: `asserts-on` > `exercises` > `reaches`. New
  module `src/core/analyzer/test-evidence.ts`, built on the def-use edges in
  `src/core/analyzer/cfg.ts`.
- **`verify_claim` kind `tested`** in `src/core/services/mcp-handlers/claim-verification.ts`.
  `confirmed` only with an `asserts-on` relationship, citing test file, test name, and assertion
  line. `refuted` only when a reachable symbol has no test relationship at all. Everything else is
  `unverifiable`, with the class found or the unrecognized framework named.
- **`blast_radius` and `verify_change`**: each test in the tests-to-run list carries `evidence`
  (the class), and each changed symbol carries `strongestEvidence`. `select_tests` returns the
  same field with its reason. The selected set does not change.
- **One advisory finding, `changed-symbol-no-asserting-test`**, on `verify_change` and so on the
  before-stop receipt: a changed symbol whose tests are in a recognized framework and none of them
  asserts on it. Action: write the assertion, or record why not.
- **Declared framework support.** The language registry (`src/core/analyzer/language-support.ts`)
  gains an `assertionRecognition` capability, true only where a recognizer exists.

## What does not change

- No new tool. `select_tests` selects the same tests. `report_coverage_gaps` is untouched.
- The finding is advisory by default; blocking is opt-in through `enforcement.policy`.
- No test is run. No coverage tool, no mutation, no LLM, no network.
- Works with any test framework or none: an unrecognized framework gives `reaches` with the reason.

## Limits we disclose

- `asserts-on` means "an assertion consumed this symbol's output." It does not mean the behavior
  is correct or fully specified. No answer uses the bare word "tested" as a guarantee.
- The data-flow check stays inside one test body. It follows a helper in the same file one level;
  past that it stops and reports `exercises` with the reason.
- A symbol with no `asserts-on` evidence is never called "untested" when the framework's
  assertions were not recognized.
- First recognizers: Vitest/Jest `expect`, Node `assert`, pytest `assert`, Go `testing` with
  testify. Other frameworks are declared unsupported.
- Mutation probing is out of scope; see `design.md`.

## Depends on

Nothing. It reuses the shipped CFG/def-use overlay, `select_tests`, and `verify_claim`.
