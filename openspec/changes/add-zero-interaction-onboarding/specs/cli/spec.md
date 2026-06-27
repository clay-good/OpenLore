# cli spec delta

## ADDED Requirements

### Requirement: ZeroInteractionOnboarding

The onboarding path SHALL reach a working setup with no required user interaction and without modifying
the user's project on package install. Installing the package (`npm install`) SHALL NOT analyze, write
configuration, or modify any project file; it MAY print a single non-interactive next-step hint, and
that hint SHALL be suppressed in CI, in non-interactive (non-TTY) contexts, when opted out via
`OPENLORE_SKIP_POSTINSTALL`, and when the package is installed as a transitive dependency. The
post-install step SHALL always exit 0 and SHALL never fail an install.

The setup commands SHALL offer a fully non-interactive path: `openlore install` SHALL auto-detect agent
surfaces and wire them with no prompt, and `openlore connect --yes` SHALL wire every detected agent
without the interactive picker. These wiring operations SHALL remain idempotent and SHALL preserve
user-authored content (merge, not clobber).

#### Scenario: Installing the package does not touch the project

- **GIVEN** a user runs `npm install -g openlore` (or `npm install openlore`)
- **WHEN** the install completes
- **THEN** no project file is created or modified and no index is built by the install itself
- **AND** at most a single next-step hint is printed, suppressed in CI / non-TTY / opt-out / dependency contexts
- **AND** the post-install step exits 0 regardless

#### Scenario: Connect is non-interactive with --yes

- **GIVEN** a project with a detectable agent and no TTY picker desired
- **WHEN** `openlore connect --yes` runs
- **THEN** every detected agent is wired with no prompt, idempotently, preserving existing content

### Requirement: ColdStartSelfBootstrap

When the MCP server begins serving a directory that has no analysis index, it SHALL build the index
once, automatically, so the first session is not permanently degraded. The build SHALL run in the
background (it SHALL NOT block the tool call or hang the agent's turn), SHALL be attempted at most once
per directory per process, SHALL be fail-soft (a build failure SHALL NOT propagate to the caller), and
SHALL be disableable via `OPENLORE_NO_AUTO_ANALYZE`. The server SHALL NOT perform a blocking full
analyze on a synchronous tool-call or hook path.

#### Scenario: A wired-but-unanalyzed server warms itself

- **GIVEN** an agent has wired the MCP server but never ran `openlore install` (no index exists)
- **WHEN** the server starts watching the directory on the first tool call
- **THEN** it begins building the index once in the background, without blocking the call
- **AND** the build is not retried while one is in flight, and a failure leaves the graceful "no analysis yet" guidance in place

### Requirement: PassiveUpdateNotifier

The CLI SHALL passively inform a human when a newer published version is available, without blocking,
and SHALL provide an explicit upgrade command. The version check SHALL be cached and refreshed at most
about once per day, the cached result SHALL be read and printed synchronously while any stale refresh
runs in the background un-awaited, and every network and disk operation SHALL be fail-silent (never
throwing, never breaking a command). The notice SHALL be suppressed in CI, in non-TTY contexts, when
`OPENLORE_NO_UPDATE_NOTIFIER` or `NO_UPDATE_NOTIFIER` is set, and under `--quiet`, and SHALL be shown
only for human-facing commands — never on the hot paths an agent drives (`orient`, `mcp`, `serve`,
hooks). The CLI SHALL NOT update itself automatically. `openlore update` SHALL detect the install
method (Homebrew, global npm, or npx) and run the correct upgrade, with `--check` and `--dry-run`
reporting without changing anything.

#### Scenario: A human-facing command notes an available update without blocking

- **GIVEN** a cached check showing a newer version and an interactive terminal
- **WHEN** a human-facing command runs
- **THEN** a one-line "update available — run openlore update" notice is printed to stderr instantly from cache
- **AND** the command is not delayed by any network call
- **AND** the notice is absent in CI, non-TTY, opt-out, and `--quiet` contexts, and on agent hot paths

#### Scenario: openlore update upgrades by install method

- **GIVEN** openlore was installed globally via npm (or via Homebrew)
- **WHEN** `openlore update` runs and a newer version exists
- **THEN** it runs `npm install -g openlore@latest` (or `brew upgrade openlore`) respectively
- **AND** for an npx invocation it reports that npx already floats to the latest and changes nothing
