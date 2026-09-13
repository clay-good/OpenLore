# mcp-quality spec delta

## MODIFIED Requirements

### Requirement: Tool Behavior Annotations

Every tool SHALL declare accurate behavior annotations (`readOnlyHint`, `destructiveHint`,
`idempotentHint`, and `openWorldHint`) so a host can reason about side effects. Read-only analysis
tools SHALL be marked read-only; tools that write files or mutate the decision store SHALL be marked
accordingly and SHALL distinguish idempotent writes from non-idempotent ones, and a tool that
overwrites or irreversibly changes user-authored state SHALL be marked destructive. A tool that can
reach the network or an LLM SHALL be marked open-world; a tool that only performs local analysis
SHALL NOT. A human-gated tool SHALL carry an annotation reflecting that it requires authorization.

The annotation table SHALL have no silent default: every advertised tool SHALL have an explicit entry,
a tool without one SHALL fail CI, and the server SHALL NOT serve fallback read-only hints for it. The
read-only split SHALL be checked by a CI test that follows each tool's dispatch target through the
source's resolved calls to file-writing and process-spawning primitives; the only writes a read-only
tool may reach are named, audited rebuildable-cache and self-repair paths.

#### Scenario: Annotations match real side effects
- **GIVEN** any tool
- **WHEN** its annotations are compared to its handler's behavior
- **THEN** read-only tools have `readOnlyHint: true`, file/state-mutating tools have `readOnlyHint: false` with correct `destructiveHint`/`idempotentHint`, and the annotation matches what the handler actually does

#### Scenario: A new tool without an annotation entry fails CI
- **GIVEN** a tool added to `TOOL_DEFINITIONS` with no corresponding `TOOL_ANNOTATIONS` entry
- **WHEN** the annotation-coverage test runs
- **THEN** the test fails, naming the unannotated tool
- **AND** the server never serves that tool with fallback read-only hints

#### Scenario: A read-only tool that reaches a write fails CI
- **GIVEN** a tool declared `readOnlyHint: true` whose dispatch target can call a file-writing or process-spawning primitive through any chain of resolved calls
- **WHEN** the annotation-accuracy test runs
- **THEN** the test fails with the call chain, unless the chain ends in a named, audited cache or self-repair path
