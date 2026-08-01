# Tasks — fix-git-path-quoting

## Implementation
- [x] Shared helper (one home for the discipline): `gitPathArgs()` in `src/utils/git-args.ts`
      prepends `-c core.quotepath=false` to every path-parsing git spawn's argv
- [x] Adopt it at the provenance site: `git-provenance.ts` `gitLog()` (the single spawn both the
      `--no-merges` and `--merges` passes route through). NOTE: `:220` is the `gh` PR-enrichment
      path, which parses PR metadata, not file paths — correctly untouched
- [x] Adopt it at the coupling site: `change-coupling.ts` (`git log --name-only`)
- [x] Adopt it at the drift sites: `git-diff.ts` all six path spawns (`--name-status` ×4,
      `--numstat` ×2); parsers (`parseNameStatus`, `parseNumstat`) unchanged
- [x] Adopt it at the decisions-gate site: `extractor.ts` `getStagedFiles` (`--cached --name-status`)
- [x] Extended to the remaining path-list spawns the same silent-drop class reaches (guard demands
      every site): `structural-diff.ts` (`--name-status`, `ls-files`), `confidence-boundary.ts`
      (`--name-only`), `impact-certificate.ts` + `public-surface.ts` (`ls-files --others`),
      `refresh-stories.ts` (`diff`/`diff-tree --name-only`), `decisions.ts` (`--cached --name-only`),
      `preflight/diff.ts` (`--name-only` ×2). `git status --porcelain` used only for a dirty boolean
      (no path join) left untouched; `git show ref:path` takes the path as input, not output — untouched

## Verification
- [x] Fixture test (`git-path-quoting.test.ts`): temp repo with committed `café.ts` (quotepath left
      at its default) → provenance, coupling, and drift changed-file detection each return the exact
      unquoted repo-relative path
- [x] Join test: the non-ASCII file participates in the analyzer join — provenance authors, churn
      ≥ 3, co-change with its ASCII peer, and membership in the ChangedFile set — not silently dropped
- [x] Sanity assertion: raw `git log --name-only` DOES octal-escape (`\303\251`) by default, so the
      test proves the code (not the repo config) is what disables quoting
- [x] Guard test (`git-args.test.ts`): scans `src/` for quoted `--name-only`/`--name-status`/
      `--numstat`/`ls-files` argv tokens not routed through `gitPathArgs` — a new unguarded site fails
      CI; includes a negative-control assertion that the guard actually detects an unguarded spawn
- [x] Decisions-gate path form: a staged non-ASCII source file (`módulo.py`) appears in the
      `--cached --name-status`-derived changed set
- [x] ASCII regression: full suite green (6002 passed; the one failure is the known, unrelated
      watcher-parity timeout flake — passes 14/14 in isolation)

## Spec
- [x] `analyzer` delta: ADD GitPathOutputFidelity
- [x] `drift` delta: ADD ChangedFilePathsAreUnquoted
