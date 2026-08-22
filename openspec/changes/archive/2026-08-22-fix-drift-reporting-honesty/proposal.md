# Fix drift reporting honesty: silent truncation, hook failures reported as drift, and invisible memory-staleness kinds

> Status: BUILT (2026-08-22). Verified with 348 focused tests, the full 8,105-test suite
> (8,103 passed, 2 skipped), 187 end-to-end integration tests, lint, typecheck, build, strict
> OpenSpec validation, and four multi-agent adversarial review rounds. Three honesty defects in how drift
> results reach the consumer: `check_spec_drift` silently truncates the changeset at 100 files
> (and its own totals disagree about it), the pre-commit hook reports every infrastructure
> failure as "Spec drift detected!", and the summary renderers omit the two memory-staleness
> issue kinds entirely. Plus two verified minors in the drift toolchain.

## Why

- **(a) Silent changeset truncation, internally inconsistent.** `handleCheckSpecDrift` slices
  `gitResult.files` at `maxFiles` (default `DEFAULT_DRIFT_MAX_FILES = 100`, `constants.ts:160`)
  with no disclosure field (`src/core/services/mcp-handlers/analysis.ts:373-376`). The result is
  then self-contradictory: `totalChangedFiles` is restored to the pre-slice count (`:409`) while
  `specRelevantFiles` (`src/core/drift/drift-detector.ts:776`) is computed over the truncated
  slice. `hasDrift: false` can rest on 150 unanalyzed files — and `blast_radius` composes this
  handler (`src/core/services/mcp-handlers/blast-radius.ts:228`), so the briefing inherits the
  blind spot. CLI parity: `src/cli/commands/drift.ts:495-501` warns only when `!opts.json` — the
  JSON consumed by CI and the hook carries no truncation marker at all.
- **(b) The hook cries "drift" at every failure.** The installed hook tests only `$? -ne 0` and
  prints "openlore: Spec drift detected! Commit blocked." (`drift.ts:134-139`, full branch
  `:137-168`). But the CLI exits 1 for a dozen non-drift reasons: not a git repo
  (`drift.ts:395-399`), no config (`:403-407`), no specs (`:446-450`), any thrown error
  (`:658-663`) — and `npx` itself failing, with `2>/dev/null` (`:134`) hiding the evidence. The
  hook also runs `npx --yes openlore` — the published npm version, not the repo-local build
  (silent version skew against the index that repo's tooling wrote).
- **(c) Memory-staleness kinds are invisible in every summary.** `displaySummary` builds its
  parts from gaps/stale/uncovered/orphaned/adr-gap/adr-orphaned only (`drift.ts:103-109`);
  `memoryDrifted`/`memoryOrphaned` (`drift-detector.ts:796-797`) are never rendered. A
  memory-only run prints the issues, then "Summary: No issues found", then exits 1 with "Drift
  detected: 1 warning". The hook's embedded summary has the same omission (`drift.ts:149-152`),
  and `kindLabel` (`:63-73`) has no cases for the two memory kinds.
- **Verified minors, folded in:** `suggestTestsForDrift`'s `scenarioCount` increments once per
  FILE, not per scenario (`src/core/drift/test-suggester.ts:117`) — a misnamed metric; its
  `walkTestFiles` skips any directory whose name contains a dot (`test-suggester.ts:48`
  `else if (!entry.includes('.'))`), unlike the coverage-analyzer's walker
  (`src/core/test-generator/coverage-analyzer.ts:58-64`, which probes dotted names via
  `readdir`) — the two spec-tag walkers have silently different reach. And
  `detectStaleSpecs`'s docstring claims "deleted or heavily modified"
  (`drift-detector.ts:220`) while only deleted/renamed is detected — fix the claim, not the
  behavior.

## What Changes

1. **Truncation receipt.** `DriftResult` gains `analyzedFiles` / `filesOmitted`; both the MCP
   handler and the CLI JSON path populate them when the changeset is sliced (the `briefing_since`
   truncation-receipt discipline). `specRelevantFiles` is documented as computed over
   `analyzedFiles`, ending the internal contradiction; `blast_radius` surfaces a non-zero
   `filesOmitted` as a caveat.
2. **Distinct exit codes + an honest hook.** The drift CLI exits 1 ONLY for "drift found" and a
   distinct code (2) for "could not check" (no repo/config/specs, thrown error). The hook message
   branches on the code: drift → the existing blocked message; could-not-check → a plain "drift
   could not be checked (<reason>); commit allowed" that does NOT block (blocking on
   infrastructure failure was never opted into) and does not swallow stderr for that branch. The
   hook prefers a repo-local `openlore` binary when present, falling back to `npx` with the
   fallback disclosed in the hook comment.
3. **Complete summaries.** `displaySummary`, the hook's embedded summary, and `kindLabel` render
   `memoryDrifted`/`memoryOrphaned`; a run whose only issues are memory-kind never prints
   "No issues found" while exiting non-zero.
4. Minors: rename the per-file tally honestly (`testFileCount`) or count real scenarios; align
   `walkTestFiles` with the coverage-analyzer's walker; correct the `detectStaleSpecs` docstring.

Verified NOT covered by filed changes: `fix-cli-output-hygiene`'s summary defect is
doctor-specific; `fix-cli-conclusion-honesty` has no drift coverage.

## Why this is in scope

Honest boundaries are the substrate's contract (decision `c6d1ad07`): disclose what could not be
checked, never truncate silently. (a) is the canonical silent-truncation violation — a
`hasDrift: false` conclusion resting on unanalyzed input with no receipt; (b) reports a
protection failure as a finding, the inverse of honesty; (c) computes an issue kind and then
hides it from every human-facing total. All fixes are deterministic reporting changes — no new
analysis, no LLM, and blocking behavior only ever narrows (infrastructure failure stops
masquerading as drift).

## Impact

- Files: `src/core/services/mcp-handlers/analysis.ts` (receipt fields),
  `src/cli/commands/drift.ts` (exit codes, hook template, summaries, kindLabel),
  `src/core/drift/drift-detector.ts` (result type + docstring),
  `src/core/drift/test-suggester.ts` (walker + metric name),
  `src/core/services/mcp-handlers/blast-radius.ts` (surface the receipt as a caveat); tests
  alongside each.
- Specs: `drift` — 1 ADDED requirement (DriftTruncationCarriesAReceipt); `cli` — 2 ADDED
  requirements (DriftHookDistinguishesFailureFromDrift, DriftSummariesRenderEveryIssueKind).
- Risks: the exit-code split is a CLI contract change — existing scripts treating any non-zero
  as "drift" now see 2 for infrastructure failure; disclosed in CHANGELOG, and the installed
  hook is re-generated by `--install-hook`. Receipt fields are additive at runtime, but the
  publicly exported TypeScript `DriftResult` now requires them, so consumer mocks and producers
  of that shape must add both counts. Hook re-install upgrades the marked block in place; hooks
  owned by non-shell managers or ending in an unconditional exit require manual wiring.
