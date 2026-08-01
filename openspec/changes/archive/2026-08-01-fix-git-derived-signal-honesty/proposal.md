# Git-derived signal honesty: prior churn measured before the change, no stale capability claims, work-tree-aware repo detection

> Status: PROPOSED (2026-07-08, e2e audit fifth pass). Three sites where the git-derived signal
> layer misreports its window, scope, or capabilities: `briefing_since` counts the briefed commits
> as "prior" churn (demoting its own highest-signal tier), `blast_radius` hard-codes a claim that
> a shipped capability doesn't exist, and `isGitRepository` fails for any directory below the
> repo root, silently emptying every git-derived signal.

## The defect(s)

1. **`briefing_since`'s "prior churn" includes the briefed commits themselves.**
   `src/core/services/mcp-handlers/briefing-since.ts:133` calls `analyzeChangeCoupling(absDir)`,
   whose miner (`src/core/provenance/change-coupling.ts:107-110`) runs
   `git log --max-count=1000 …` from HEAD — so churn counts include every commit in the briefed
   `baseRef..HEAD` range. The tier contract requires churn BEFORE the change: the field is
   literally named `priorChurn` (`src/core/analyzer/change-significance.ts:96-97`, "Prior commits
   that touched this file"), and the `surprising-change` definition (`:15-20`) is a hub "whose
   file has LOW churn … rarely changed before". A hub file untouched for 995 commits then
   hammered 6 times in the briefed range reads `volatilityLevel` medium → the surprise label is
   WITHHELD for exactly the highest-signal event the tier exists for, and it demotes
   deterministically as the change's significance rises. Secondary: `historyAvailable =
   coupling.stats.commitsScanned >= 2` (`briefing-since.ts:138`) also counts briefed commits, so
   a repo whose entire history IS the briefed range claims enough history to assert "rarely
   changed before" with zero actual before.
2. **`blast_radius` returns a hardcoded false capability claim.**
   `src/core/services/mcp-handlers/blast-radius.ts:303-306` (verified verbatim):
   `federation: { evaluated: false, note: '…multi-repo federation not yet shipped —
   add-multi-repo-federation…' }`. Federation shipped on PR #167; the composed
   `handleSelectTests` — imported by this very file at `:22` — has working
   `federation`/`federationRepos` options (`test-impact.ts:270-280`). `blast_radius` is in the
   DEFAULT `substrate` preset: every default-surface agent is told at runtime that a shipped
   capability does not exist.
3. **`isGitRepository` is `access(root/.git)`.** `src/core/drift/git-diff.ts:131-138` — a
   monorepo package directory (`repo/packages/foo`) fails the check even though every git
   shell-out with that cwd would succeed (worktrees/submodules pass only because `.git` is a
   file there). Consequences, all silent-empty or misleading: `extractProvenance`
   (`src/core/provenance/git-provenance.ts:124`) and `analyzeChangeCoupling`
   (`change-coupling.ts:97`) return empty; `structural_diff` hard-errors "Not a git repository"
   (`structural-diff.ts:90-92`); `briefing_since` withholds surprise with a misleading
   "history too shallow" framing; `get_change_coupling`'s error message conflates three causes,
   none of them the real one.

## What changes

- **Churn window placed before the change.** `analyzeChangeCoupling` gains an optional
  starting-point argument (one extra arg to the existing `git log` shell-out — log from
  `resolvedBase` instead of HEAD); `briefing_since` passes its resolved base so `priorChurn` and
  `volatilityLevel` are computed strictly over pre-change history, and `historyAvailable` is
  derived from that window's `commitsScanned`. Default behavior for all other callers unchanged.
  Not covered by `add-complexity-trend-signal` (a trend label, not window placement) nor the
  shipped shallow-history withholding (total depth, not which commits count as "before").
- **Capability claim corrected.** Either forward a `federation` option through `blast_radius` to
  the composed `select_tests`, or (minimum) replace the note with the truth: "not evaluated by
  this tool — use `select_tests` with `federation: true`". No claim of nonexistence for a shipped
  capability. Suggest `add-doc-claim-sync-guards` extend its CI-guard idea from doc literals to
  in-payload capability claims (suggestion only; do not modify that change's files).
- **Work-tree-aware repo detection with honest path framing.** `isGitRepository` uses
  `git rev-parse --is-inside-work-tree`. Because git emits repo-root-relative paths while node
  `filePaths` are rootPath-relative, exact-path churn/provenance joins would still miss below the
  root — so the second layer is either path re-framing (translate via
  `git rev-parse --show-prefix`) or, at minimum, an explicit disclosed boundary: "analyzed
  directory is inside a repository but not its root; git-derived signals unavailable". Today it
  is silent-empty; after this change it is either correct or disclosed. Not covered by
  `fix-git-path-quoting` (quoting, not detection/framing).

## Why this is in scope

The substrate's whole warrant (decision `c6d1ad07`) is that its signals are grounded and its
boundaries honest. A tier that deterministically demotes its own highest-signal event
mismeasures the thing it is named for; a default-preset tool asserting a shipped capability
doesn't exist is a live false claim on every call; and a detection predicate that silently zeroes
churn, provenance, coupling, and diffs for every monorepo subdirectory is a silent-empty boundary
of exactly the kind the language-support and parse-health work eliminated. All three fixes are
deterministic, local, git-native; no LLM, no new tuning constant, nothing blocking.

## Impact

- Files: `src/core/provenance/change-coupling.ts` (window arg),
  `src/core/services/mcp-handlers/briefing-since.ts` (pass base; window-scoped
  `historyAvailable`), `src/core/services/mcp-handlers/blast-radius.ts` (federation claim),
  `src/core/drift/git-diff.ts` (`isGitRepository`) + the disclosed-boundary or path-framing layer
  at its callers; tests alongside.
- Specs: `mcp-handlers` — 2 ADDED requirements (PriorChurnIsMeasuredBeforeTheBriefedRange,
  BriefingCapabilityClaimsAreCurrent); `drift` — 1 ADDED requirement
  (GitRepositoryDetectionIsWorkTreeAware).
- Tool surface: unchanged (no new tool, no payload-budget impact).
- Risk: low-medium. Surprise-tier output changes on repos with heavy briefed ranges (intended —
  that is the defect); subdirectory analyses that silently got empty signals start getting real
  ones or an explicit boundary, which may surface previously hidden churn joins to verify.
