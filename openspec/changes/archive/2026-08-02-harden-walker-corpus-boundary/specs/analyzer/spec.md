# analyzer spec delta

## ADDED Requirements

### Requirement: WalkerDisclosesEveryDroppedCorpusMember

The file walker SHALL account for every directory entry it does not analyze: an entry
excluded for ANY reason — including a symlink dirent and the `maxFiles` cap — SHALL be
counted under a named skip reason or truncation receipt surfaced with the walk result. The
walker SHALL NOT drop an entry through a code path that records nothing. When the walk stops
at the `maxFiles` cap, the result SHALL carry an explicit truncation marker (the limit and
where the walk stopped) so a partial corpus is never presented as complete. If symlink
following is implemented, it SHALL be cycle-safe via resolved-path tracking and the followed
count SHALL be disclosed.

#### Scenario: A symlinked source tree is disclosed, not vanished

- **GIVEN** a repository whose `src/` is a symlink
- **WHEN** analysis walks the repository
- **THEN** the walk summary reports the symlink under a named reason (skipped or followed),
  and the corpus is explainable from the summary alone

#### Scenario: The maxFiles cap carries a truncation receipt

- **GIVEN** a repository with more analyzable files than `maxFiles`
- **WHEN** the walk stops at the cap
- **THEN** the walk result includes a truncation marker with the limit, and the analyze
  summary discloses that the corpus is partial

#### Scenario: A symlink cycle terminates

- **GIVEN** a directory containing a symlink that resolves into an ancestor of itself
- **WHEN** symlink following is enabled
- **THEN** the walk terminates, the linked tree is analyzed at most once, and the summary
  discloses the followed link

### Requirement: IncludePatternsOverrideDirectoryPruning

Configured `includePatterns` SHALL override every exclusion layer, including directory-level
pruning: a directory that matches (or is an ancestor of a path matching) an include pattern
SHALL be descended into even when it is a built-in skip directory, gitignored, or matched by
`excludePatterns`, so the documented "includePatterns override all exclusions" contract
holds at file granularity. No include pattern SHALL be a silent no-op because its directory
was pruned before any file was tested.

#### Scenario: An include under a built-in skip directory is honored

- **GIVEN** `includePatterns: ["vendor/mylib/**"]` and `vendor` in the built-in skip set
- **WHEN** the walk runs
- **THEN** files under `vendor/mylib/` enter the corpus, while other `vendor/` content
  remains pruned

#### Scenario: An include under a gitignored directory is honored

- **GIVEN** a directory excluded by `.gitignore` and an include pattern targeting a file
  inside it
- **WHEN** the walk runs
- **THEN** the included file enters the corpus and the rest of the directory remains
  excluded

### Requirement: NestedGitignoreSemantics

The walker SHALL honor `.gitignore` files in subdirectories with git's scoping semantics —
a nested file's patterns apply to its own subtree — not only the repository root's
`.gitignore`, so that files git ignores do not enter the graph as analyzable source.

#### Scenario: A subdirectory .gitignore excludes its subtree's files

- **GIVEN** `packages/app/.gitignore` containing `generated/`
- **WHEN** the walk reaches `packages/app/generated/`
- **THEN** its files are excluded and counted under the gitignore skip reason

#### Scenario: Nested patterns do not leak to siblings

- **GIVEN** the same nested `.gitignore`
- **WHEN** the walk reaches `packages/lib/generated/`
- **THEN** that sibling directory is unaffected by `packages/app`'s patterns
