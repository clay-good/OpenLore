# mcp-quality spec delta

## ADDED Requirements

### Requirement: DirectoryDefaultsToTheServerRoot

Every tool whose `directory` argument is omitted SHALL have it resolved to the server's launch
root (the working directory the MCP server was started in), validated by exactly the same
directory checks as an explicit value. An explicit `directory` argument SHALL always override the
default. The tool input schemas SHALL declare `directory` optional and document the default. When
the launch root cannot serve as a valid directory, the error SHALL name the expected value with a
concrete example path.

#### Scenario: Orient works without a directory argument

- **GIVEN** an MCP server started via the install-wired `.mcp.json` in a project root with an
  existing index
- **WHEN** the client calls `orient` with only a `task`
- **THEN** the call succeeds against the launch root, identically to passing that root explicitly

#### Scenario: An explicit directory still wins

- **GIVEN** the same server
- **WHEN** the client passes a different valid `directory`
- **THEN** the call runs against the explicit directory

### Requirement: UnknownArgumentsAreRejectedNotDropped

Tool argument validation SHALL fail on unrecognized top-level properties. The error SHALL name
the unrecognized property and, when a near match exists among the schema's properties, suggest it
(did-you-mean). A tool SHALL NOT execute — and in particular SHALL NOT persist state — on a call
whose arguments contained properties it did not understand.

#### Scenario: A mis-named anchor is rejected instead of silently unanchored

- **GIVEN** the `remember` tool whose schema anchors memories via its declared anchor property
- **WHEN** a client calls it with `anchor: "chargeCard"` (not a schema property)
- **THEN** the call fails with an error naming `anchor` and suggesting the correct property, and
  no memory is persisted

### Requirement: MissingArgumentErrorsAreSelfServe

A missing-required-property error SHALL name the property, its expected shape, and a concrete
example value the caller can use directly.

#### Scenario: The error teaches the fix

- **GIVEN** a tool call missing a required property with no resolvable default
- **WHEN** validation fails
- **THEN** the error contains the property name, its type, and an example value — enough for the
  model to correct the call without external documentation
