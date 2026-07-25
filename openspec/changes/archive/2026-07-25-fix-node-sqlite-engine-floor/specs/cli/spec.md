# cli spec delta

## ADDED Requirements

### Requirement: NodeFloorMatchesSqliteCapability

The declared Node.js floor (`engines.node`, the runtime guard's `MIN_NODE`, doctor's constants,
and user-facing documentation) SHALL be a version on which every statically imported builtin —
in particular `node:sqlite` — is available without runtime flags, and all floor declarations SHALL
be kept equal by an automated test. The runtime guard and `openlore doctor` SHALL verify
`node:sqlite` availability by probing the module itself (e.g.
`process.getBuiltinModule('node:sqlite')`), not by version arithmetic alone; a probe failure SHALL
produce the established one-line legible failure (stderr message + stable exit code 78), never an
uncaught import crash, and doctor SHALL report it as a failing check naming the missing capability.

#### Scenario: A Node inside the old declared range but below the working floor is rejected legibly

- **GIVEN** openlore launched under Node 22.10 (where `node:sqlite` requires a flag nobody passes)
- **WHEN** the CLI entry guard runs
- **THEN** the process exits with code 78 and one stderr line naming the required Node floor,
  before any `node:sqlite` import can throw a stack trace

#### Scenario: Capability probe overrides version arithmetic

- **GIVEN** a Node build whose version number satisfies the floor but on which the `node:sqlite`
  probe fails (re-flagged or stripped builtin)
- **WHEN** the guard or `openlore doctor` evaluates the environment
- **THEN** the verdict is failure with a message naming `node:sqlite` unavailability — the passing
  version number is never presented as evidence the product can run

#### Scenario: Floor declarations cannot drift apart

- **GIVEN** the floor is declared in package.json `engines`, the version guard, and constants
- **WHEN** any one declaration is changed without the others
- **THEN** an automated test fails, keeping one floor across all declarations and doctor/README copy
