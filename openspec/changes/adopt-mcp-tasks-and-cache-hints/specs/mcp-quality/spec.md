# mcp-quality spec delta

## ADDED Requirements

### Requirement: NewProtocolFeaturesWaitForAFinalRevisionAndClientSupport

MCP cache hints, tasks, 2020-12 input schemas, and the stateless core SHALL NOT reach the wire
until the defining specification revision is final, the pinned SDK supports it, and Claude Code
supports it. When adopted, the migration SHALL keep every fact the custom `initialize` handler
carries (preset pointer, real package version, client identity), SHALL keep the handshake for
older protocol versions, and SHALL change no tool, preset membership, or answer content.

#### Scenario: An unmet gate blocks the work

- **WHEN** any of the three gates is not met
- **THEN** only the gate-tracking task is in progress and no new wire behavior ships

#### Scenario: Old and new clients both get the preset pointer

- **WHEN** a client with the handshake and a client without it each start a session
- **THEN** both receive the preset pointer and the real package version

### Requirement: SchemasExpressParameterExclusivity

A tool whose parameters are mutually exclusive SHALL declare that in its input schema (`oneOf` or
equivalent) once the final revision permits it, and not only in description text. The runtime
argument validator SHALL remain, and its error text SHALL name the offending parameters. Schema
growth SHALL stay inside the `tools/list` payload budget.

#### Scenario: find_clones exclusivity is declarative

- **WHEN** a host validates a `find_clones` call that carries both `symbol` and `snippet`, or
  neither, against the declared schema
- **THEN** the call is rejected before dispatch, and a call with exactly one passes
