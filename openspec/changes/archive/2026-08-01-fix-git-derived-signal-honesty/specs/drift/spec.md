# drift spec delta

## ADDED Requirements

### Requirement: GitRepositoryDetectionIsWorkTreeAware

The system SHALL detect "is a git repository" by asking git whether the path is inside a work
tree, not by testing for a `.git` entry at the analyzed root. For an analyzed directory that is
inside a repository but not at its root, every git-derived signal (churn, coupling, provenance,
structural diff) SHALL either operate correctly — with file paths re-framed between the
repository root and the analyzed root — or return an explicit disclosed boundary stating that
git-derived signals are unavailable below the repository root. A silent empty result SHALL never
stand in for either outcome.

#### Scenario: A monorepo package directory is recognized as a repository

- **GIVEN** an analyzed directory at `repo/packages/foo` inside a git repository
- **WHEN** repository detection runs
- **THEN** the directory is recognized as inside a git work tree

#### Scenario: Below-root analysis is correct or disclosed, never silent-empty

- **GIVEN** a below-root analyzed directory and a request for churn or provenance
- **WHEN** the git-derived signal is computed
- **THEN** either the paths are re-framed and the signal is populated
- **OR** the response discloses that git-derived signals are unavailable below the repository root
- **AND** no empty result is returned without that disclosure

#### Scenario: structural_diff does not refuse a real repository

- **GIVEN** `structural_diff` invoked on a below-root directory of a git repository
- **WHEN** the handler validates its input
- **THEN** it does not return "Not a git repository"

#### Scenario: Worktrees and submodules keep passing

- **GIVEN** a git worktree or submodule checkout (where `.git` is a file)
- **WHEN** repository detection runs
- **THEN** the directory is recognized as a git repository
