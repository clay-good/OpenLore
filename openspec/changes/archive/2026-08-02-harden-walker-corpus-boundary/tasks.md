# Tasks — harden the walker corpus boundary

## Implementation
- [ ] Symlink dirents (file-walker.ts:492-504): capture `entry.isSymbolicLink()` in the
      entry record; `recordSkip('symlink')` instead of silent double-false filtering; if
      following is implemented, resolve via realpath with a visited-set (cycle-safe) and
      count `symlink-followed` separately
- [ ] Include-aware directory pruning: `shouldSkipDirectory` (:409-437) and the
      directory-level gitignore prune (:520) consult `igInclude` first — a directory on (or
      a prefix of) an include pattern is descended; file-level `shouldSkipFile` (:442-445)
      unchanged
- [ ] Resolve the unreachable `bin` entry-point check (:316 vs SKIP_DIRECTORIES :52):
      reachable via include patterns, or removed with a comment
- [ ] Nested `.gitignore`: on directory entry, read a local `.gitignore` if present and add
      its patterns scoped to that subtree (extend `loadIgnorePatterns` :332-368 or compose
      per-directory ignore instances)
- [ ] Truncation receipt: hitting `maxFiles` (:474,:509,:531; default constants.ts:157 via
      :389) records `truncated: { limit, atPath }` in the walk result; analyze summary
      discloses it
- [ ] Posix-normalize `path.relative()` results before every `ig.ignores()` call
      (:449, :456, :520) — the named sites for `fix-windows-invocation-surface`

## Verification
- [ ] Fixture repo with a symlinked `src/`: walk summary shows the symlink skip (or the
      followed count), and with following enabled the graph contains the linked tree once
      (cycle fixture: self-referencing symlink terminates)
- [ ] `includePatterns: ["vendor/mylib/**"]` admits files under `vendor/mylib/` (pruned
      today); a gitignored-but-included directory is walked; non-included `vendor/` siblings
      stay pruned
- [ ] Nested-gitignore fixture: a file ignored only by a subdirectory `.gitignore` is
      excluded and counted under the gitignore skip reason
- [ ] maxFiles=small fixture: result carries the truncation receipt; summary renders it
- [ ] Windows-shaped unit test: backslash relative paths are normalized before `ignore`
      (assert via injected separator, no CI-on-Windows dependency)
- [ ] Full suite green

## Spec
- [ ] `analyzer` delta: ADD WalkerDisclosesEveryDroppedCorpusMember,
      IncludePatternsOverrideDirectoryPruning, NestedGitignoreSemantics
