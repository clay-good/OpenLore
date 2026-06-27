# mcp-quality spec delta

> Applied (2026-06-22): the live `openspec/specs/mcp-quality/spec.md` requirement this modifies is
> named **`Tool Surface Size and Progressive Disclosure`** (not the working title below). That live
> requirement was updated in place to make the lean `navigation` default normative (SHALL, not the
> prior aspirational SHOULD), invert it from `MINIMAL_TOOLS` to the `navigation` preset, and correct a
> stale `~45 tools` count to 62. The text below is the authoring intent and reads identically.

## MODIFIED Requirements

### Requirement: MinimizeToolSurfaceTheAgentMustConsider

The system SHALL minimize the number of tools an agent must consider by default, because tool schemas
the agent never calls are pure per-request overhead and a larger candidate set degrades tool-selection
accuracy. The **default** MCP surface (no preset selected) SHALL therefore be a lean, evidence-backed
subset — the Spec 14 benchmark-winning navigation-first surface — and SHALL NOT be the full
`TOOL_DEFINITIONS` registry. Breadth (the full surface and every governance/memory/federation
capability) SHALL remain available strictly by opt-in (a named preset or an explicit full-surface
selector). New tools added to the registry SHALL default to opt-in and SHALL NOT enter the lean
default surface without an evidence-backed decision.

#### Scenario: The default surface stays lean as the registry grows

- **GIVEN** a new tool is added to `TOOL_DEFINITIONS`
- **WHEN** the default (no-preset) surface is resolved
- **THEN** the new tool is absent from the default surface unless an explicit decision added it, and
  the default surface remains the lean navigation-first subset

#### Scenario: Breadth is reachable but never the default

- **GIVEN** an agent that needs a governance, memory, or federation tool
- **WHEN** it opts into the corresponding named preset (or the full surface)
- **THEN** the capability is available, while the default surface every other session pays for stays
  lean
