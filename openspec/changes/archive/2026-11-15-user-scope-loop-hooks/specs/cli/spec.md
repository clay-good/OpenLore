# Delta for cli

## ADDED Requirements

### Requirement: UserScopeLoopHooksAreGuardedAndStandDown

A user-scope Claude Code install SHALL wire the agent-loop moments as well as the session-start and
prompt hooks. Each user-scope loop command SHALL exit 0 before starting Node when the project
directory has no `.openlore/`. Every user-scope hook command SHALL carry `--scope user`, and such a
command SHALL do nothing when the repository's own Claude settings wire the same step with a
repo-scope command, so one event yields one receipt. `openlore doctor` SHALL NOT report that pair
as a duplicate.

#### Scenario: Outside an OpenLore project the loop hooks cost nothing

- **GIVEN** a user-scope install
- **WHEN** an edit happens in a project with no `.openlore/`
- **THEN** the hook exits 0 before Node starts and prints nothing

#### Scenario: A worktree with no repo wiring gets the receipts

- **GIVEN** a user-scope install and a git worktree with `.openlore/` and no `.claude/settings.json`
- **WHEN** the agent writes to a generated file
- **THEN** the before-edit receipt is printed

#### Scenario: A repository wired at both scopes is told once

- **GIVEN** a user-scope install and a repository whose `.claude/settings.json` wires the same moment
- **WHEN** the moment fires
- **THEN** only the repo-scope command prints, and `openlore doctor` reports no duplicate
