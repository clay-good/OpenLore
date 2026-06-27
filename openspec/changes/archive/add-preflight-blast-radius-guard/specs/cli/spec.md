# cli spec delta

## ADDED Requirements

### Requirement: PreflightHookIsOptInAndAdvisory

The CLI SHALL provide explicit installation of an advisory pre-flight git hook that emits the structural
blast-radius briefing, reusing the install pattern of the decisions pre-commit hook. Installation SHALL
be an explicit opt-in command (`openlore blast-radius --install-hook`), never auto-installed by
`openlore setup`, and the installed hook SHALL be advisory (exit 0) by default. The hook SHALL honor
`.openlore/config.json` to enable blocking for specific high-risk patterns only.

#### Scenario: The hook is installed explicitly, never silently

- **GIVEN** an OpenLore project
- **WHEN** the user runs `openlore blast-radius --install-hook`
- **THEN** the advisory pre-flight hook is installed, and it is never auto-installed by `openlore setup`

#### Scenario: Configuration enables targeted blocking

- **GIVEN** an installed advisory pre-flight hook
- **WHEN** `.openlore/config.json` enables blocking for a named high-risk pattern
- **THEN** the hook blocks only on that pattern and stays advisory otherwise
