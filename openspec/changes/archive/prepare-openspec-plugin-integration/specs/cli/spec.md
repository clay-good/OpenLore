# cli spec delta

## ADDED Requirements

### Requirement: PluginManifestCommand

The system SHALL provide a CLI command `openlore plugin-manifest` with `emit` and `validate`
subcommands that inspect and validate the OpenSpec **plugin** manifest OpenLore publishes (the
`"openspec"` key in `package.json`). This command SHALL be named distinctly from the federation
`openlore manifest` command so the two artifacts never collide. `emit --json` SHALL print only the
manifest JSON on stdout. `validate` SHALL exit zero when the manifest is valid and non-zero when it is
not, reporting which field failed.

#### Scenario: Emit prints the manifest as JSON

- **GIVEN** OpenLore's `package.json` declares an `"openspec"` plugin manifest
- **WHEN** `openlore plugin-manifest emit --json` is run
- **THEN** stdout carries only the manifest JSON (namespace `lore`, bin `openlore`) and nothing else

#### Scenario: Validate rejects an incoherent manifest

- **WHEN** `openlore plugin-manifest validate` runs against a manifest missing a required field or with
  no executable (`bin`/`binArgs`)
- **THEN** the command exits non-zero and names the offending field

### Requirement: GracefulNodeVersionGuard

When the OpenLore CLI is launched under a Node version below its supported floor (≥22.5), it SHALL fail
fast before running any command: a single legible stderr line naming the required and actual versions,
and a stable, dedicated non-zero exit code (78), rather than a stack trace or a partial run. The floor
SHALL stay coherent with `package.json` `engines.node`.

#### Scenario: Spawned under an unsupported Node

- **GIVEN** a host on Node 20 that supports OpenSpec but not OpenLore
- **WHEN** `openspec lore generate` spawns OpenLore
- **THEN** OpenLore writes one stderr line naming the Node requirement and exits with code 78, never a
  stack trace

### Requirement: DelegatedCommandsAreSubprocessSafe

Every OpenLore subcommand surfaced in the plugin manifest (`generate`, `drift`, `verify`, `analyze`,
`orient`, `digest`, `decisions`) SHALL be safe to run as a delegated, non-interactive child process: it
SHALL return a deterministic exit code, SHALL NOT block on an interactive prompt when stdin/stdout is
not a TTY, SHALL emit machine-readable output (when offered via `--json`) only on stdout with logs on
stderr, and SHALL resolve the project from its working directory.

#### Scenario: Machine output keeps stdout pure

- **GIVEN** a surfaced command run with `--json`
- **WHEN** the command logs progress while it works
- **THEN** progress/log lines go to stderr and stdout carries only the JSON result

#### Scenario: Non-interactive spawn does not hang

- **GIVEN** a surfaced command spawned with no TTY
- **WHEN** it would otherwise prompt the user
- **THEN** it proceeds with a safe default or exits fast with a clear message, and never hangs on stdin
