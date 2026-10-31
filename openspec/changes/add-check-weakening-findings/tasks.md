# Tasks — add-check-weakening-findings

## Implementation
- [ ] Closed shape table + per-framework marker lists (Vitest/Jest/Mocha, pytest/unittest, Go
      testing, JUnit, Rust, RSpec); suppression list per language; assertion-call lists
- [ ] Baseline resolution: merge-base via `resolveBaseRefDisclosed`, baseline text read through git;
      never the agent's last commit
- [ ] Closed per-language logging-call list for `error-swallowed`
- [ ] Detectors: `test-removed`, `test-disabled`, `assertions-reduced`, `expected-value-changed`,
      `suppression-added`, `error-swallowed`, `check-config-relaxed`
- [ ] Reach join: each finding names the production symbols the weakened test reached at baseline
- [ ] Register the 7 codes in `FINDING_CODE_REGISTRY` (advisory); project into `verify_change` and
      `structural_diff`
- [ ] Unsupported language/framework → `not-assessed` per file

## Verification
- [ ] One fixture per shape; each yields exactly its code with the reached symbols named
- [ ] Two-step weakening (weaken in commit 1, edit in commit 2) is still found against the merge-base
- [ ] `expected-value-changed` does NOT fire when a reached production symbol also changed
- [ ] Wording guard: no finding message contains judgmental terms ("cheat", "hack")
- [ ] Full suite green

## Spec
- [ ] `mcp-handlers` delta: ADD CheckWeakeningIsReportedAgainstAFixedBaseline
