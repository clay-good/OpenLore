# cli spec delta

## ADDED Requirements

### Requirement: UpdateDetectsInstallMethodCorrectly

`openlore update` SHALL determine how the running openlore was installed from deterministic local
evidence (resolved package root compared against the npm global prefix, project `package.json`
dependency declaration, npx-cache and Homebrew path signals), with path matching agnostic to
separator style so Windows paths classify identically to POSIX paths. The command SHALL only
execute a mutating upgrade whose scope matches the proven install method: a global upgrade
(`npm install -g`) only for a proven global install, and for a project-local dependency it SHALL
print the per-project command (`npm install openlore@latest`) rather than mutating global state.
When the evidence is absent or contradictory the verdict SHALL be `unknown`, disclosed to the user
with manual upgrade instructions — never a guessed method that runs a mutating command.

#### Scenario: A project-local install is not upgraded globally

- **GIVEN** openlore running from `<project>/node_modules/openlore/` as a declared project
  dependency, with a newer version published
- **WHEN** the user runs `openlore update`
- **THEN** no `npm install -g` is executed
- **AND** the command reports the newer version and prints `npm install openlore@latest` as the
  project-scoped upgrade command

#### Scenario: A Windows global install is detected

- **GIVEN** openlore running from a Windows global npm path (backslash separators, under the npm
  global prefix)
- **WHEN** install-method detection runs
- **THEN** the method resolves to `npm-global`, identically to the equivalent POSIX path

#### Scenario: Indeterminate evidence is disclosed, not guessed

- **GIVEN** a module path matching no known install signal, or signals that contradict each other
- **WHEN** the user runs `openlore update`
- **THEN** the method is `unknown`, the user receives the manual upgrade instructions, and no
  mutating command is executed

#### Scenario: npx stays a no-op

- **GIVEN** openlore running from an npx cache path
- **WHEN** the user runs `openlore update`
- **THEN** the command explains that npx floats to the latest version and executes nothing
