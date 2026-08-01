# Git path quoting: history-derived joins silently drop non-ASCII filenames

> Status: SHIPPED (2026-07-19, PR #249). Implemented as the shared
> `gitPathArgs()` helper in `src/utils/git-args.ts` (`-c core.quotepath=false`), adopted at every
> path-list git spawn (log/diff/diff-tree `--name-only`/`--name-status`/`--numstat` and
> `ls-files`), with a structural guard test (`git-args.test.ts`) that fails CI on a new unguarded
> site and a non-ASCII fixture test (`git-path-quoting.test.ts`) proving provenance, coupling, and
> drift changed-file detection all return the exact unquoted path. Originally proposed
> (2026-07-03, e2e audit follow-up). Every git-history shell-out parses file
> paths from stdout under git's default `core.quotepath=true`, which octal-escapes and quotes any
> path with non-ASCII bytes — `src/café.ts` comes back as `"src/caf\303\251.ts"` and never matches
> the analyzer's repo-relative paths. Provenance, coupling, drift, and everything joined on them
> (blast radius, coverage gaps, briefing) quietly lose those files. One shared quoting discipline
> at every spawn site, plus a regression guard so new sites can't reintroduce it.

## The gap

Git's default `core.quotepath=true` renders a path containing bytes above 0x80 as a
double-quoted, octal-escaped C string in `--name-only`/`--name-status`/`--numstat` output. No
spawn site in the tree disables it (zero hits for `quotepath` in `src/`), and every parser treats
the quoted string as the literal path:

- **Provenance** — `git log --name-only` (`src/core/provenance/git-provenance.ts:88-92`, second
  pass at `:220`); the parser splits raw lines into `files` (`:98-106`) and joins them against a
  `Set` of analyzer repo-relative paths, so a quoted path never matches and the file silently has
  no authors/PRs.
- **Change coupling** — `git log --name-only` (`src/core/provenance/change-coupling.ts:107-111`),
  parsed at `:117-124`; a non-ASCII file gets no churn and no co-change pairs, which also starves
  `briefing_since`'s volatility tier.
- **Drift / changed files** — four `git diff --name-status` spawns
  (`src/core/drift/git-diff.ts:389,400,417,432`) parsed by `parseNameStatus` (`:250`), plus two
  `--numstat` spawns (`:453,461`) parsed by `parseNumstat` (`:272`). A quoted path flows into
  `ChangedFile.path` and matches nothing downstream — drift detection, `structural_diff`,
  `blast_radius`, `change_impact_certificate`, and `select_tests`-over-a-diff all quietly exclude
  the file.
- **Decisions gate** — `getStagedFiles` (`src/core/decisions/extractor.ts:85-88`) parses
  `--name-status` lines; a quoted path fails the extension checks in `isSourceFile` (the trailing
  `"` defeats `endsWith`), so staged non-ASCII source files escape decision extraction.

This is the silent-drop failure class: no error, no boundary disclosure — the results are just
smaller than the repo, exactly where a user with `café.ts` or `模块.py` can't see it.

## What changes

**One quoting discipline at every history/diff spawn site, enforced by a guard test.**

- Pass `-c core.quotepath=false` as the leading argv elements at EVERY `git log` / `git diff`
  spawn that parses paths from stdout (the eight sites above; `rev-parse` sites don't emit paths
  and are untouched). Where the output format supports it and the parser is line-record based,
  `-z` NUL-termination is the stricter alternative — implementation may choose it per site, but
  the default fix is the config flag, which changes only the escaping, not record structure.
- A small shared helper (e.g. `gitPathArgs()` or a wrapped `execGit`) owns the flag so the
  discipline has one home; call sites adopt it rather than each remembering the incantation.
- **Regression guard:** a test greps `src/` for `execFile`-style git spawns of `log`/`diff` whose
  argv lacks the quotepath guard (or NUL mode) — a new unguarded site fails CI, mirroring the
  registry-derived can't-over-claim pattern used elsewhere.
- Fixture test: a temp repo with a committed non-ASCII filename (`café.ts`) asserts provenance,
  coupling, and changed-file detection all return the exact repo-relative path, unquoted.

## Why this is in scope

Every conclusion tool that joins git history against the graph inherits this hole, and the
failure is the worst kind under the house doctrine: quietly smaller results presented as
complete, with no boundary disclosure. The fix is deterministic, local, one flag with no tuning
constants, and the guard test converts a per-site discipline into a structural invariant.

## Impact

- Files: `src/core/provenance/git-provenance.ts`, `src/core/provenance/change-coupling.ts`,
  `src/core/drift/git-diff.ts`, `src/core/decisions/extractor.ts` (+ the shared helper's home);
  guard test + non-ASCII fixture test.
- Specs: `analyzer` — 1 ADDED requirement (GitPathOutputFidelity); `drift` — 1 ADDED requirement
  (ChangedFilePathsAreUnquoted).
- Tool surface: unchanged (no new tool; provenance/coupling/drift/blast-radius/briefing results
  become complete for non-ASCII paths).
- Risk: low. ASCII-only repos see byte-identical output; the flag is supported by every git
  version the tree already depends on. Rename records (`R100` two-path lines) are covered by the
  existing `parseNameStatus` tab splitting once paths arrive unquoted.
