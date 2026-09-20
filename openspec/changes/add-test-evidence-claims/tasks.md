# Tasks

## 1. Assertion recognition

- [ ] 1.1 Add per-framework assertion recognizers identifying assertion call sites and their asserted
  argument positions; verify each with a fixture per supported framework
- [ ] 1.2 Declare framework support in the capability matrix and `docs/language-support.md`; verify an
  unsupported framework is reported as such

## 2. Classification

- [ ] 2.1 Compute the local def-use check inside a test body answering whether an assertion argument
  derives from a call to the subject symbol, reusing the existing overlay; verify with tests for the
  direct-return and inline-argument shapes
- [ ] 2.2 Follow a same-file test helper one level and stop with a disclosed reason beyond that;
  verify both the followed and the stopped case
- [ ] 2.3 Emit the three classes with the strongest-wins rule and verify ordering with a symbol
  carrying two relationships of different classes
- [ ] 2.4 Verify no test is executed and no coverage instrumentation is required, by asserting the
  analysis runs on a repository whose test suite cannot run

## 3. Surfaces

- [ ] 3.1 Carry the class on `select_tests` reasons and verify selection itself is unchanged by
  comparing selected sets before and after
- [ ] 3.2 Sharpen the coverage-gap report's wording with the class and verify the set of reported
  gaps is unchanged
- [ ] 3.3 Add the `tested` claim kind to `claim-verification.ts` with its receipt; verify
  `confirmed`, `refuted` and the three `unverifiable` causes each with a test
- [ ] 3.4 Verify the honesty wording at every surface: no bare "tested" guarantee, and absence of
  evidence never reported as untested

## 4. Verification

- [ ] 4.1 Run the classifier over this repository and record the distribution of the three classes in
  the change
- [ ] 4.2 Measure added analysis time on this repository's test suite and record it
- [ ] 4.3 Run `openspec validate --strict` and the reaching tests from `openlore select-tests`;
  verify both are green
