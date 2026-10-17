## ADDED Requirements

### Requirement: OptionalFeatureDependenciesDegradeAtTheirOwnCommand

A package that only one command needs SHALL be an optional dependency, loaded dynamically at the
point of use rather than at module scope. This applies to the graph viewer's build toolchain and UI
runtime, and to the stdio MCP transport SDK. A package that no code under `src/` imports SHALL NOT
be a dependency at all.

The CLI SHALL start, list its commands, and run every command that does not need an optional
package, with that package absent. Analysis, the programmatic API, and the local HTTP daemon SHALL
all function with every optional feature dependency absent — none of them may require the viewer
toolchain or the stdio transport SDK.

When a command whose feature dependency is absent is invoked, it SHALL fail with a message that
names the missing package and the exact install command that fixes it, and SHALL NOT surface a raw
module-resolution error. Absence SHALL be reported as an uninstalled optional feature, never as a
broken installation. This is the same fail-soft posture the optional tree-sitter grammars and the
local embedding service already take.

#### Scenario: The CLI starts without the optional packages

- **GIVEN** an installation with the viewer toolchain and the stdio transport SDK absent
- **WHEN** the user runs the CLI with no arguments or `--help`
- **THEN** it starts and lists every command, including the ones whose dependency is absent

#### Scenario: Analysis and the daemon do not need them

- **GIVEN** the same installation
- **WHEN** the user analyzes a repository and starts the local HTTP daemon
- **THEN** both succeed, and no optional feature package is loaded

#### Scenario: A viewer command names its missing package

- **GIVEN** an installation without the viewer build toolchain
- **WHEN** the user runs the viewer command
- **THEN** it reports the missing package and the install command, and no raw module-resolution
  error reaches the user

#### Scenario: The stdio MCP command names its missing package

- **GIVEN** an installation without the stdio transport SDK
- **WHEN** the user starts the stdio MCP server
- **THEN** it reports the missing package and the install command, and the HTTP daemon remains
  usable as the alternative transport

#### Scenario: An unreferenced package is not a dependency

- **GIVEN** a package declared in `dependencies` that no file under `src/` imports
- **WHEN** the dependency audit runs
- **THEN** it fails naming that package
