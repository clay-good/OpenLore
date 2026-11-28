---
name: openlore-write-tests
description: Write and run real tests for a function or spec scenario after reading implementation and contract evidence. Use when asked to add, improve, or repair tests without stubs or placeholders.
---

# openlore: Write Tests

Write tests that assert on real results. A test that only calls a function proves little.

## Step 1 — Target and framework

Name the function or scenario to test. Find the test framework from the repository (its config and
existing test files). Use the same framework and the same file layout as the nearest existing test.

## Step 2 — Orient

Call `orient` with the target. Keep its file, its `callPaths`, and its `specDomains`. Then call
`verify_claim` with kind `tested` on the target. `confirmed` cites a test whose assertion consumes
its output (file, test, line): extend that test before you add a new file. `refuted` means no test
calls or reaches it. `unverifiable` means a test calls or reaches it but none is known to assert on
its result.

## Step 3 — Read the contract

Call `get_function_skeleton` on the file, then read the function body. The contract is, in order:
a requirement in the owning spec domain (when there is one), the function's documented behavior,
then its callers' expectations (`get_subgraph` with `direction: "upstream"`). Call `recall` for facts recorded about it.

## Step 4 — Write the tests

1. **No placeholder assertions.** Every assertion checks a real return value or side effect.
2. **One test, one scenario.** Name the test after the scenario or the contract statement.
3. **Tag a test for a spec scenario** on the line above its suite, so OpenLore's spec coverage
   counts it: `// openlore: {"domain":"<d>","requirement":"<r>","scenario":"<s>"}` (`#` in Python).
   Leave the tag out when no spec scenario exists.
4. **Mock only system boundaries:** the filesystem, network, processes, and clocks. Never the
   function under test or its pure helpers.
5. **At least one edge case:** empty input, a missing value, a limit, or an error path.
6. **Prove it is not vacuous.** Break the code on purpose (one line), see the test fail, restore it.

## Step 5 — Run and fix

Run the new tests. If you also changed code, call `blast_radius` on the diff and run every file in
its `tests.files`. A failing test is either a bug in the test (fix the test) or a bug in the code (report it,
and fix it only if the task allows).

## Step 6 — Check the evidence

Call `verify_claim` with kind `tested` on the target again, once the index has picked up the new
tests. It should now be `confirmed` and cite your test.

## Constraints

- Do not weaken or delete an existing assertion to make a run pass.
- Keep each test file small enough to read in one pass; split by concern.

## Close with one action per finding

- **Fix it**: the test, or the code bug the test exposed, with the run as proof.
- **Record a decision** when you chose not to test something:
  `openlore decisions record --title "<choice>" --rationale "<proof>" --files <paths>` where the
  CLI is installed; with the plugin alone, state the decision and its proof in your final message.
- **Raise it to the human** only when the evidence warrants it: a breaking change to a contract used
  outside the repository, overriding an accepted decision, an added secret, or a finding you cannot
  settle from the evidence.
