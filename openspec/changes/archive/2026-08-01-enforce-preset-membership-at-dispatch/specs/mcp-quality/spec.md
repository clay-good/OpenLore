# mcp-quality spec delta

## ADDED Requirements

### Requirement: PresetMembershipIsEnforcedAtDispatch

The MCP server SHALL enforce the active preset at `tools/call`: a registered tool that is not a
member of the active preset SHALL NOT execute. The rejection SHALL be a tool execution error
(`isError: true`), not a protocol error, and its text SHALL name the requested tool, the active
preset, at least one preset that contains the tool, and the rewire command. A deprecated tool
alias SHALL resolve to its canonical name before the membership check. The advertised surface
(`tools/list`) and the callable surface SHALL be the same set, guarded by a CI test that
checks every preset with at least one out-of-surface call and by a wire-protocol test that
exercises the dispatch boundary.

#### Scenario: A hidden navigation tool is not callable on the default surface

- **GIVEN** a server started with the default `substrate` preset
- **WHEN** the client calls `tools/call` with `find_dead_code` and valid arguments
- **THEN** the response is a tool error naming `find_dead_code`, the `substrate` preset, a preset
  that contains the tool, and `openlore install --preset <name>`, and no analysis is performed

#### Scenario: A member tool is unaffected

- **GIVEN** the same server
- **WHEN** the client calls `orient` with valid arguments
- **THEN** the call dispatches exactly as before this change

#### Scenario: An unknown name is still distinguished from an out-of-surface name

- **GIVEN** the same server
- **WHEN** the client calls a name registered in no preset and no definition
- **THEN** the response is the existing unknown-tool error, not the membership error
