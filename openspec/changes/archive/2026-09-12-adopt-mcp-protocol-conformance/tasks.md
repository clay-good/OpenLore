# Tasks — adopt MCP protocol conformance

## Implementation
- [x] Remove the `?? _RO` fallback in `toolAnnotations`; require an explicit `TOOL_ANNOTATIONS`
      entry per tool in `TOOL_DEFINITIONS`
- [x] Annotation guard: fails CI when a tool lacks an entry, or when a read-only tool's dispatch target
      reaches a write or spawn primitive through resolved calls outside the audited cache paths
- [ ] ~~`outputSchema` + `structuredContent` for the `substrate` tools~~ — deferred (see proposal)
- [x] Convert argument-validation failures from `McpError(InvalidParams)` to `isError: true` tool
      results with parameter name, expected shape, and a corrected example call
- [ ] ~~Elicitation transport for decision approval~~ — deferred (see proposal)
- [x] Record the MCP 2026-07-28 RC (stateless core, initialize removal) as a WATCH comment on the
      custom initialize handler

## Verification
- [x] `tool-guard.test.ts`: wrong type, out-of-enum, and missing-required messages carry an example;
      the actionable message names the tool and a corrected call
- [x] Conformance integration test: a malformed argument yields an `isError` tool result that names
      the parameter and an example
- [x] Full suite green
