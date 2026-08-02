# Harden the walker corpus boundary: no silently smaller graph

> Status: PROPOSED (2026-07-08, e2e audit fifth pass). The file walker decides the analyzed
> corpus and never discloses what it dropped — the exact "silently smaller graph" class
> `add-parse-health-boundary-disclosure` (pass 1) fixes for parse/encoding failures,
> unapplied at the walker (extends that change; new sites). Symlinks vanish without a skip
> reason, the documented includePatterns override is a no-op against directory pruning, and
> only the root `.gitignore` is honored.

## The defect(s)

- **(a) Every symlink is silently dropped.** `walkDirectory`
  (`src/core/analyzer/file-walker.ts:492-504`) buckets dirents by
  `entry.isDirectory()`/`entry.isFile()`; a symlink dirent returns false for BOTH, so it is
  filtered out of both lists without ever reaching `recordSkip()` (`:401-404`). Nothing in
  `skippedReasons` or the summary. A repo whose `src/` (or a pnpm-linked workspace package)
  is a symlink analyzes to an empty/partial graph — and every downstream tool then honestly
  reports "no callers" over a silently truncated corpus.
- **(b) includePatterns cannot override directory pruning — the documented contract is
  violated.** `shouldSkipFile` (`:442-445`) says "includePatterns override all exclusions —
  check first" and consults `igInclude`, but `shouldSkipDirectory` (`:409-437`) and the
  directory-level gitignore prune (`:520`,
  `this.ig.ignores(relativeSubPath + '/')`) never do. Any include pattern under a
  `SKIP_DIRECTORIES` entry (`vendor`, `bin`, `android`, …, `:46-63`), a gitignored
  directory, or an `excludePatterns` directory is a silent no-op: the directory is pruned
  before any file inside it is ever tested. Corollary: the `bin` entry-point check at
  `:316` (`['src', 'lib', 'bin'].includes(dir)`) is unreachable — `bin` is in
  `SKIP_DIRECTORIES` (`:52`), so no file under `bin/` survives to be classified. A user who
  sets `includePatterns: ["vendor/mylib/**"]` per the documented override gets an analysis
  that quietly contains nothing from it.
- **(c) Only the root `.gitignore` is read.** `loadIgnorePatterns` (`:349-356`) reads
  `join(rootPath, '.gitignore')` once. Nested `.gitignore` files — standard git semantics,
  common in monorepos — are ignored entirely, so files git ignores enter the graph as
  analyzable source, inflating stats and dead-code/coverage-gap candidates.
- **Fold-in (extends `add-parse-health-boundary-disclosure`):** the `maxFiles` cap
  (`:474`, checked again at `:509`/`:531`; default `DEFAULT_MAX_FILES = 100_000`,
  `constants.ts:157`, applied at `file-walker.ts:389`) stops the walk with NO truncation
  receipt — a repo over the cap gets a partial corpus that presents as complete.
- **Fold-in (extends `fix-windows-invocation-surface` — naming the site):**
  `path.relative()` output (`:480`, `:512`, `:534`) is fed to the `ignore` package
  (`:449`, `:520`), which accepts only posix separators — on Windows the backslash paths
  make gitignore/exclude matching silently fail (nothing excluded, or everything walked).

## What changes

1. **Symlinks become a disclosed skip reason.** Symlink dirents are counted as
   `recordSkip('symlink')` and surfaced in the walk summary alongside the other reasons.
   Optionally (same change, flag-free): resolve non-cyclic symlinks via a visited-realpath
   set so a symlinked `src/` analyzes instead of vanishing — cycle-safe by construction,
   and still disclosed (`symlink-followed` count) so the corpus is explainable.
2. **includePatterns override every exclusion layer.** `shouldSkipDirectory` and the
   directory-level gitignore prune consult `igInclude` first: a directory that is (or
   contains a prefix of) an include pattern is descended into, and the file-level check
   (`:442-445`) then applies as documented. The unreachable `bin` entry-point check at
   `:316` either becomes reachable through an include pattern or is removed with a comment
   — no dead branch presenting as behavior.
3. **Nested `.gitignore` files are honored.** When entering a directory that contains a
   `.gitignore`, its patterns are added scoped to that subtree (the `ignore` package's
   relative-prefix composition), matching git semantics.
4. **Truncation receipt at the cap.** Hitting `maxFiles` records a
   `truncated: { limit, atPath }` marker in the walk result, and the analyze summary
   discloses it — the `add-parse-health-boundary-disclosure` discipline at the walker.
5. **Posix-normalize before `ignore`.** Every `path.relative()` result crossing into
   `ig.ignores()` is separator-normalized — the concrete site list for
   `fix-windows-invocation-surface` (`:449`, `:456`, `:520`).

## Why this is in scope

The walker is where the substrate's honesty starts: every downstream conclusion — dead
code, coverage gaps, blast radius — is computed over the corpus the walker admits (decision
`c6d1ad07`: deterministic, local static analysis). A corpus silently missing a symlinked
tree, a promised include, git-ignored noise, or everything past file 100,000 makes every
honest tool dishonest at once. The fix is pure disclosure + documented-contract repair: no
LLM, no new heuristics, no new tuning constants beyond honoring what config already
promises.

## Impact

- Files: `src/core/analyzer/file-walker.ts` (symlink handling, include-aware directory
  pruning, nested gitignore, truncation receipt, posix normalization); walk-summary
  rendering where `skippedReasons` is displayed.
- Specs: `analyzer` — 3 ADDED requirements (WalkerDisclosesEveryDroppedCorpusMember,
  IncludePatternsOverrideDirectoryPruning, NestedGitignoreSemantics).
- Tool surface: unchanged (no new tool; walk summaries gain fields).
- Risk: low-medium. Following symlinks can grow the corpus (bounded by the realpath set
  and maxFiles — both disclosed); nested gitignore can shrink it (that shrink is the
  correct corpus); include-aware pruning only ADDS files the user explicitly asked for.
