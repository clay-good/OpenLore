# Spec Delta

## ADDED Requirements

### Requirement: NewWorktreeIsSeededFromASiblingCheckout

When a directory inside a git work tree has no index, and another checkout of the same repository
(the same git common directory) holds a published index that verifies and attests healthy, the
first build SHALL seed from that index, serve it at once, and start a background rebuild that reuses
the seeded per-file memo. Each answer during the rebuild SHALL carry the repair reason `seeded`, and
each cited file whose content differs from the seed SHALL be reported behind the working tree.

#### Scenario: A new worktree answers on its first call

- **GIVEN** a main checkout with a healthy index, and a new linked worktree of the same repository
  with no `.openlore` directory
- **WHEN** the first `orient` call runs in the worktree
- **THEN** it returns functions and call paths from the seeded index, with a repair marker naming
  `seeded`, and a background rebuild has started

#### Scenario: Files the worktree changed are named, not hidden

- **GIVEN** a seeded worktree whose branch changed one file relative to the seed
- **WHEN** an answer cites that file before the rebuild finishes
- **THEN** that file, and only that file, is reported behind the working tree

### Requirement: SeedingCopiesOnlyVerifiedArtifacts

Seeding SHALL copy only the known analysis artifacts, never symbolic links or runtime state. Any
failure to find, verify or copy a seed SHALL fall back to the cold build. Seeding SHALL obey the same
opt-outs as auto-initialization.

#### Scenario: An unverifiable seed is never used

- **GIVEN** a sibling index whose manifest fails to verify, or that is mid-build
- **WHEN** the worktree's first call runs
- **THEN** no artifact is copied and the ordinary cold build starts
