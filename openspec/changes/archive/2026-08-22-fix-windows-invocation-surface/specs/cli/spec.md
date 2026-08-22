# cli spec delta

## ADDED Requirements

### Requirement: WindowsInvocationResolvesOrDiscloses

The package-manager commands used by `openlore update` for install evidence and upgrades, and every
launch command written into a generated agent config (MCP server entries, hooks, slash commands),
SHALL be resolvable on the platform where it will run. On Windows, `npm` and `npx` invocations SHALL
be emitted or spawned through an explicit launchable invocation, owned by one shared
platform-resolution helper rather than per-site fixes. The project SHALL additionally state its
platform support explicitly: either Windows is exercised by CI, or the documentation declares its
support tier and `doctor` discloses it at runtime — a platform is never implied-working while
known-broken.

#### Scenario: `openlore update` executes its upgrade on Windows

- **GIVEN** a Windows machine where the install method resolves to a runnable upgrade command
- **WHEN** `openlore update` runs the upgrade
- **THEN** the spawn resolves the platform's executable form of `npm` and runs it, instead of
  failing ENOENT and reporting exit code 127

#### Scenario: A generated config launches on the platform that generated it

- **GIVEN** `openlore install` run on Windows wiring an MCP client that spawns the server directly
- **WHEN** the client starts the configured command
- **THEN** the written command is executable on win32 (not a bare `npx` the client cannot
  resolve), and configs generated on macOS/Linux are unchanged

#### Scenario: Support is stated, not implied

- **GIVEN** a user evaluating OpenLore on Windows
- **WHEN** they consult the README or run `openlore doctor`
- **THEN** they find either CI-backed Windows support or an explicit best-effort tier statement —
  never silence that implies parity
