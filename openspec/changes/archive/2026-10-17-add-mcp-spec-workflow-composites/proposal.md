## Why

OpenLore's deterministic evidence is available to every MCP client, but only the Pi extension currently offers efficient Generate and Repair compositions. Generic MCP hosts must rediscover and sequence several primitives themselves, which weakens parity, increases round trips, and makes workflow correctness depend on client-specific instructions.

## What Changes

- Add read-only `prepare_spec_generation` and `prepare_spec_repair` MCP tools that compose the existing deterministic primitives into bounded, domain-scoped evidence responses.
- Keep semantic interpretation, specification authoring, and file editing in the host agent; the composite tools never generate prose or write specifications.
- Make Repair preserve orphaned-spec evidence and include both current and historical domain paths when scoping structural changes.
- Refactor Pi's native Generate and Repair entry points to consume the same public MCP composite contracts instead of implementing their own composition.
- Provide thin host skills that call the composites, inspect explicit completeness receipts, drill into atomic tools only when necessary, and use the host's ordinary editing workflow.
- Retain all atomic MCP evidence tools for targeted follow-up and compatibility.

## Capabilities

### New Capabilities

- `mcp-spec-workflow-composites`: Client-neutral, read-only Generate and Repair evidence compositions plus their completeness, provenance, and host-skill contract.

### Modified Capabilities

- `mcp-handlers`: Expose and dispatch the two composite specification-workflow tools with bounded, honest response contracts.

## Impact

- MCP tool registry, schemas, dispatch and contract tests.
- Shared domain-evidence and spec-reconciliation composition services.
- Pi extension entry points and parity tests.
- OpenLore Generate/Repair skills for supported coding agents.
- Documentation of the agent-neutral workflow. No provider SDK, ACP dependency, autonomous spec-writing tool, or MCP file-writing primitive is introduced.
