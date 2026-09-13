# mcp-quality spec delta

## ADDED Requirements

### Requirement: StandardToolAnnotationsAreEmittedAndGuarded

Every tool on the MCP surface SHALL carry an explicit, accurate set of standard MCP annotations —
`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` — alongside the
capability `family`. The annotation table SHALL have no silent default: a tool without an explicit
entry SHALL fail CI, and the server SHALL NOT serve fallback hints for it, so a future mutating
tool can never be advertised as read-only by fallback. The read-only/mutating split SHALL be
verified by a test against each tool's audited dispatch target, not merely asserted.
`openWorldHint` SHALL be `false` for every tool that performs only local analysis.

#### Scenario: A new tool without an annotation entry fails CI

- **GIVEN** a tool added to `TOOL_DEFINITIONS` with no corresponding `TOOL_ANNOTATIONS` entry
- **WHEN** the annotation-coverage test runs
- **THEN** the test fails, naming the unannotated tool
- **AND** the server never serves that tool with fallback read-only hints

#### Scenario: A mutating tool cannot be declared read-only

- **GIVEN** a tool whose dispatch target writes persistent state
- **WHEN** the annotation-coverage test compares its declared hints to its dispatch target
- **THEN** a `readOnlyHint: true` declaration on that tool fails the test

#### Scenario: Local tools declare a closed world

- **GIVEN** any tool that performs only local analysis (no LLM, no network)
- **WHEN** its annotations are emitted in `tools/list`
- **THEN** `openWorldHint` is `false`
