# Tasks — fix drift reporting honesty

## Implementation
- [x] `DriftResult` gains `analyzedFiles` / `filesOmitted`; populated on slice in
      `handleCheckSpecDrift` (analysis.ts:373-376) and the CLI JSON path (drift.ts:495-501);
      document `specRelevantFiles` as computed over `analyzedFiles`
- [x] `blast_radius` surfaces non-zero `filesOmitted` from the composed drift result as a caveat
      (blast-radius.ts:228 call site)
- [x] Exit-code split in the drift CLI: 1 = drift found (drift.ts:654-655), 2 = could not check
      (no repo :395-399, no config :403-407, no specs :446-450, thrown error :658-663)
- [x] Hook template (drift.ts:127-171): branch on exit code — drift → blocked message;
      could-not-check → honest "could not be checked (<reason>); commit allowed", non-blocking,
      stderr not swallowed on that branch; prefer repo-local `openlore` binary over `npx --yes`
      with the fallback disclosed
- [x] Render memory kinds: `displaySummary` (drift.ts:103-109), the hook's embedded summary
      (:149-152), and `kindLabel` (:63-73) cover `memoryDrifted` / `memoryOrphaned`
- [x] Minors: rename `scenarioCount` to an honest per-file metric or count real scenarios
      (test-suggester.ts:117); align `walkTestFiles` dot-directory handling
      (test-suggester.ts:48) with coverage-analyzer.ts:58-64; fix the `detectStaleSpecs`
      docstring claim (drift-detector.ts:220)

## Verification
- [x] 150-file changeset at default maxFiles=100: JSON carries `analyzedFiles: 100`,
      `filesOmitted: 50`; `totalChangedFiles` and `specRelevantFiles` no longer contradict
- [x] Hook repro: run the hook in a repo with no `.openlore` config → message says "could not be
      checked", commit proceeds, no "Spec drift detected!"
- [x] Hook repro: real drift at threshold → exit 1, blocked message unchanged
- [x] Memory-only drift run: summary lists the memory kind, never "No issues found" alongside a
      non-zero exit
- [x] Walker parity: a test file under a dotted directory (e.g. `spec-tests/v1.2/`) is reached by
      both spec-tag walkers
- [x] Full suite green

## Spec
- [x] `drift` delta: ADD DriftTruncationCarriesAReceipt
- [x] `cli` delta: ADD DriftHookDistinguishesFailureFromDrift
- [x] `cli` delta: ADD DriftSummariesRenderEveryIssueKind
