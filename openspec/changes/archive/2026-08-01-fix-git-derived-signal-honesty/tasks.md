# Tasks — git-derived signal honesty

## Implementation
- [x] `analyzeChangeCoupling` (`change-coupling.ts`): optional start-ref argument — `git log`
      from that ref instead of HEAD (`:107-110`); default (no arg) behavior byte-identical for
      existing callers
- [x] `briefing_since` (`briefing-since.ts:133`): pass the resolved base ref so `priorChurn` /
      `volatilityLevel` cover strictly pre-change history; derive `historyAvailable` (`:138`)
      from the pre-base window's `commitsScanned`
- [x] `blast_radius` (`blast-radius.ts:303-306`): forward a `federation` option to the composed
      `handleSelectTests` (which already supports it, `test-impact.ts:270-280`) OR correct the
      note to "not evaluated by this tool — use select_tests with federation:true"; either way,
      no "not yet shipped" claim for the shipped capability
- [x] `isGitRepository` (`git-diff.ts:131-138`): detect via `git rev-parse --is-inside-work-tree`
- [x] Below-root honesty layer: either re-frame paths for the churn/provenance joins (via
      `git rev-parse --show-prefix`) or emit the explicit disclosed boundary "inside a repository
      but not its root; git-derived signals unavailable" at `extractProvenance`,
      `analyzeChangeCoupling`, `structural_diff`, `briefing_since`, and `get_change_coupling` —
      never silent-empty
- [x] Note the suggestion on `add-doc-claim-sync-guards` (in-payload capability claims) in this
      change's proposal only — do not modify that change's files

## Verification
- [x] Fixture: hub file untouched for many commits, then changed heavily within the briefed
      range → `surprising-change` tier IS assigned (pre-base churn low); same fixture through
      the old path documented as the regression it demotes
- [x] Fixture: repo whose entire history is the briefed range → `historyAvailable` false,
      surprise withheld with the shallow-history receipt
- [x] Existing coupling/volatility callers (no start-ref) produce unchanged output
- [x] `blast_radius` payload: no "not yet shipped" text; if forwarding, federation block appears
      when opted in and absent otherwise
- [x] `isGitRepository` true for a subdirectory of a repo, a worktree, and a submodule; false
      outside any repo
- [x] Below-root call: signals correct (re-framed paths) or the disclosed boundary present;
      `structural_diff` no longer hard-errors "Not a git repository" inside a real repo
- [x] Full suite green

## Spec
- [x] `mcp-handlers` delta: ADD PriorChurnIsMeasuredBeforeTheBriefedRange,
      BriefingCapabilityClaimsAreCurrent
- [x] `drift` delta: ADD GitRepositoryDetectionIsWorkTreeAware
