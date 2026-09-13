# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ValidationErrorsAreActionable

Tool-argument validation failures SHALL be returned as Tool Execution Errors (`isError: true`
results) whose text names the offending parameter, states the expected shape, and includes a
corrected example call — not as JSON-RPC protocol errors — so the calling model can self-correct
(SEP-1303). A rejected call SHALL remain free of side effects. Genuinely malformed protocol frames
(unknown method, unparseable request) SHALL remain protocol errors.

#### Scenario: A wrong argument type yields a self-correctable tool error

- **GIVEN** a call to a tool with a parameter of the wrong type or a missing required parameter
- **WHEN** argument validation fails
- **THEN** the response is a tool result with `isError: true`
- **AND** its text names the parameter, the expected shape, and a corrected example call

#### Scenario: A malformed frame stays a protocol error

- **GIVEN** a request that is not a valid tool call at the protocol level
- **WHEN** the server processes it
- **THEN** a JSON-RPC error is returned, as today
