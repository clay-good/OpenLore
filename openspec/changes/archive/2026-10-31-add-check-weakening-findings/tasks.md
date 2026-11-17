# Tasks — add-check-weakening-findings

## Implementation
- [x] Closed shape table + per-framework marker lists (Vitest/Jest/Mocha, pytest/unittest, Go
      testing + testify, JUnit 4/5 + AssertJ); suppression list per language; assertion-call lists.
      Rust and RSpec are outside the table in this cut and are reported `not-assessed`
      ([docs/check-weakening.md](../../../docs/check-weakening.md#closed-tables)).
- [x] Baseline resolution: the merge-base of the requested base (or the default branch when none or
      `HEAD` is given) with the new state; baseline text read through git; never the agent's last
      commit (`resolveWeakeningBaseline` in `src/core/services/check-weakening.ts`)
- [x] Closed per-language logging-call list for `error-swallowed`
- [x] Detectors: `test-removed`, `test-disabled`, `assertions-reduced`, `expected-value-changed`,
      `suppression-added`, `error-swallowed`, `check-config-relaxed`
- [x] Reach join: each test finding names the production symbols the test file reaches in the
      index at its last analysis (`tested_by` edges + forward call closure), and those in code the
      diff changes; a test file with no recorded reach is disclosed
- [x] Register the 7 codes in `FINDING_CODE_REGISTRY` (advisory); project into `structural_diff`
      (`checkWeakening`) and `verify_change` (items, `findings`, `gated`, `summary.checksWeakened`)
- [x] Unsupported language/framework → `not-assessed` per file (also: no recorded reach for
      `expected-value-changed`, unparsable workflow YAML)

## Verification
- [x] One fixture per shape; each yields exactly its code with the reached symbols named
      (`src/core/services/check-weakening.test.ts`)
- [x] Two-step weakening (weaken in commit 1, edit in commit 2) is still found against the merge-base
- [x] `expected-value-changed` does NOT fire when a reached production symbol also changed
- [x] Wording guard: no finding message contains judgmental terms ("cheat", "hack")
- [x] Full suite green

## Spec
- [x] `mcp-handlers` delta: ADD CheckWeakeningIsReportedAgainstAFixedBaseline
