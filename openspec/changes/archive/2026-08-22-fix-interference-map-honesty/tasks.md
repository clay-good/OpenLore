# Tasks — interference-map honesty

## Implementation
- [x] `defaultEnumerateBranches` (`interference-map.ts:566-571`): replace the three bare
      `catch { continue; }` (merge-base, rev-parse tip, diff) with a pushed `RawChange` carrying
      `fetchError` naming the failed git operation and its error → renders as a `notAssessed`
      node with reason `diff-unfetchable` (the shape the PR path already emits at `:607`)
- [x] `resolveRepoBase` (`:535-540`): when the final fallback returns the unverifiable input ref,
      surface a map-level caveat naming the base it could not verify (so a whole-repo branch
      wipeout is explained, not silent)
- [x] `defaultEnumeratePullRequests` (`:592`): when `gh pr list` returns exactly the `--limit 50`
      rows, add a truncation caveat ("open PRs may exceed the enumeration limit")
- [x] `classifyHazard` (`change-footprint.ts:394-397`): WAR requires shared write-set FILES with
      disjoint symbols; pure read∩read overlap is dropped — never `WAR`, never counted as a conflict
- [x] `GovernanceFinding.severity` (`enforcement-policy.ts`): closed union type; migrate `'warn'`
      at `footprint-escape.ts:313`, `:322`, `:331` to the canonical spelling
- [x] Note in the add/add gap's code comment (`interference-map.ts:504`) that two branches adding
      the same new file are a textual-conflict case for `add-merge-tree-conflict-oracle`
      (comment only; do not modify that change's files)
- [x] Preserve oversized branch and PR diffs as `assessment-capped` nodes instead of silently
      assessing only the first 400 files; test the exact 400/401 boundary on both providers
- [x] Prefer remote default-branch refs in CI clones and reject an auto-resolved `HEAD~1` base for
      the interference map because it would assess only the newest commit

## Verification
- [x] Fixture: branch whose merge-base computation fails (shallow-clone simulation / injected
      provider) → appears as `notAssessed`/`diff-unfetchable`, never absent; a CI-style gate on
      `cross-actor-conflict` sees the not-assessed disclosure
- [x] Fixture: unresolvable repo base → caveat present; branches not silently dropped en masse
- [x] Fixture: invalid/non-commit/unsafe guessed bases are rejected or disclosed before assessment
- [x] Classifier tests: disjoint write-sets + one shared read → NOT `WAW`/`RAW`/`WAR` and not in
      `conflictCount`; same-file disjoint-symbol writes still `WAR`; existing WAW/RAW/shared-append
      verdicts byte-identical
- [x] `plan_parallel_work` (shared classifier) snapshot re-pinned; wave schedule unchanged for
      write-hazard fixtures
- [x] Type-level: assigning `'warn'` to `GovernanceFinding.severity` fails compilation
- [x] Full suite green

## Spec
- [x] `mcp-handlers` delta: ADD InFlightAssessmentFailuresAreDisclosed,
      ReadOnlyOverlapIsNotAConflict; MODIFY GovernanceFindingsCarryStableCodeAndIntrinsicSeverity
- [x] `cli` delta: ADD EnforcementJsonUsesVersionedSeverityVocabulary for schema version 2
