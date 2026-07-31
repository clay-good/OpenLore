# Tasks — fix drift-gate blindness

## Implementation
- [x] `getChangedFiles` (git-diff.ts): when `includeUnstaged`, also run
      `git diff --cached --numstat` and `git diff --numstat`; merge per path (summed) into
      `numstatMap` before the `?? { additions: 0, deletions: 0 }` fallback (git-diff.ts:476)
- [x] `normalizeADRId` helper (one canonical form for "ADR-23" / "ADR-023" / "ADR-0023");
      applied in `extractChangedADRIds` (drift-detector.ts:350) AND at the
      `changedADRIds.has(id)` comparison / `buildADRMap.byId` key (drift-detector.ts:382,
      spec-mapper.ts:369-373)
- [x] Replace the format-split unit tests (drift-detector.test.ts:1134 'ADR-1' vs :1177
      'ADR-001') with tests that drive extraction and suppression through the same format
- [x] Coordination note delivered on `fix-commit-gate-delivery`: drift.ts:173-207 is a third
      hooksPath-ignoring installer its "both installers" fix must also cover (no code change here)

## Verification
- [x] Live-repro regression: a staged-only 40-line change reports non-zero additions/deletions,
      gap severity `warning` (not `info`), and the hook path (`--fail-on warning`) blocks
- [x] Gap message no longer prints "+0/-0" for staged/working-tree changes
- [x] End-to-end ADR case: change `openspec/decisions/adr-0023-*.md` alongside code in one of its
      domains → NO adr-gap issue; change the code without the ADR → adr-gap fires as before
- [x] Staged + working-tree edits to the same file: counts merged (summed), no crash, no zeros
- [x] Full suite green

## Spec
- [x] `drift` delta: ADD UncommittedChangesCarryRealLineCounts
- [x] `drift` delta: ADD ADRIdentityIsNormalizedAcrossDriftDetection
