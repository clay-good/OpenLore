# cli spec delta

## ADDED Requirements

### Requirement: HookInstallersTargetTheEffectiveHooksDir

Every openlore git-hook installer (enforcement, decisions and its post-commit companion, drift,
blast-radius, impact-certificate, and refresh-stories) SHALL install into the hooks directory git actually consults — resolved via
`git rev-parse --git-path hooks`, honoring `core.hooksPath`, worktrees, and `$GIT_DIR` — never a
hard-coded `.git/hooks`. When the effective directory is owned by a hook manager, the installer
SHALL either wire the openlore block through that manager's script (same marker discipline) or
emit an explicit, actionable warning naming the manager and the required wiring; it SHALL NOT
print a success message for a hook git will never execute. `openlore doctor` SHALL verify the
gate's reachability: an openlore hook block present and executable in the effective hooks
directory, with a shadowed `.git/hooks` install reported as "installed but unreachable".

#### Scenario: A custom hooksPath repo gets a working gate

- **GIVEN** a repository with `core.hooksPath` pointing outside `.git/hooks`
- **WHEN** the user runs any OpenLore hook installer
- **THEN** the hook block lands in the configured hooks directory and a subsequent `git commit`
  actually runs the gate

#### Scenario: A hook manager is disclosed, not silently bypassed

- **GIVEN** a repository managed by a hook manager the installer cannot safely wire
- **WHEN** the installer runs
- **THEN** it emits a warning naming the manager, the effective hooks directory, and the wiring
  to add — and does not print the plain success line

#### Scenario: Doctor detects an unreachable gate

- **GIVEN** an openlore hook file in `.git/hooks/pre-commit` and a later-configured
  `core.hooksPath` that shadows it
- **WHEN** the user runs `openlore doctor`
- **THEN** the report names the gate as installed but unreachable by git, with the fix

### Requirement: MachineJsonEnvelopesCarrySchemaVersion

CLI commands that emit a machine-consumed JSON envelope (`openlore enforce --json`,
`openlore review --format json`) SHALL include a `schemaVersion` field, following the versioning
discipline the decisions store already practices, so CI consumers receive an explicit
compatibility signal when the envelope shape evolves.

#### Scenario: CI can detect an envelope shape change

- **GIVEN** a CI job parsing `openlore enforce --json`
- **WHEN** the envelope is emitted
- **THEN** it carries `schemaVersion`, and a future breaking re-shape increments that value
  instead of changing fields silently

#### Scenario: The field is additive

- **GIVEN** an existing consumer of the current envelope
- **WHEN** it parses output from the updated CLI
- **THEN** all previously documented fields are unchanged and the new key can be ignored
