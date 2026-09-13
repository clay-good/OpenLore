# Tasks — add-test-selection-safeguard-tiers

## Implementation
- [x] Always-select tiers in `handleSelectTests`: changed test files and new test files from the diff,
      plus untracked non-ignored test files (`git ls-files --others --exclude-standard` through the
      hardened git helper), unioned with reachability; a test-only diff no longer returns early
- [x] Per-test `reason` receipt (strongest tier first) and `alsoIncludedBecause`
- [x] Per-test `structuralBasis` qualifier from `buildPairEdgeIndex` over the reaching id path
- [x] Response-level confidenceBoundary unchanged
- [x] `flakiness: { assessed: false, reason }` disclosure
- [ ] ~~Flakiness history reader (JUnit XML / `gh run`)~~ — deferred: no per-test outcome source keyed
      by tree hash exists locally (see proposal)

## Verification
- [x] Tier tests: a changed-but-unreachable test file is selected with the right reason; a new
      untracked test file is selected; a deleted test is not; reachability selections keep depth-N
      reasons; a test selected by both carries the tier reason plus the other
- [x] Union-only test: tiers never remove a reachability selection
- [x] Flakiness disclosure test: no history → `assessed: false`, no test labeled
- [x] Qualifier test: a synthesized-edge-only path is labeled; a direct-resolution path is not
- [x] Review-hardening tests: subdirectory path frames, exact file match, working-tree-deleted test,
      untracked listing failure and cap, served reason agrees with its path, no cyclic `tested_by`
      path, synthesized `tested_by` basis, flakiness on the no-seed return
- [ ] ~~Payload budget re-asserted in `mcp-presets.test.ts`~~ — dropped: that test asserts no
      `select_tests` payload (see proposal)
- [x] Full suite green; no coverage-artifact code path touched
