# Spec Delta

## ADDED Requirements

### Requirement: RepoOnlyWiringIsOfferedTheUserScope

The system SHALL detect when OpenLore is wired for a repository but not for the user scope, or when
the user-scope wiring predates the current shape. `openlore doctor` SHALL report it as a warning
with the user-scope install as its remedy, and `openlore status` SHALL report the wiring scope.
`openlore doctor --fix`, and `openlore update` after a successful upgrade on an interactive
terminal, SHALL offer that remedy; `--yes` accepts it.

#### Scenario: A repo-only install is noticed

- **GIVEN** a repository with OpenLore-managed `.mcp.json` wiring and no user-scope OpenLore entry
- **WHEN** the user runs `openlore doctor`
- **THEN** a "User-scope wiring" warning names the gap ("new repositories and worktrees will not
  reach OpenLore") and the `doctor --fix` remedy

#### Scenario: An upgrade offers the rewire once

- **GIVEN** the same machine, on an interactive terminal
- **WHEN** `openlore update` upgrades successfully
- **THEN** it asks once whether to wire the user scope, and writes nothing unless the user agrees
  or passed `--yes`

### Requirement: OnlyAHumanRunCommandWritesUserConfiguration

User-level configuration SHALL be written only by an explicit, human-run command. A hook, the MCP
server, the serve daemon and auto-initialization SHALL NOT write it.

#### Scenario: Agent-driven paths never write the home directory

- **GIVEN** any hook, MCP or serve call in a repository with repo-only wiring
- **WHEN** the call completes
- **THEN** no file outside the repository and the OpenLore cache was written
