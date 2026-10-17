## Why

The first four stages of `openlore generate` fragment evidence by file or chunk, even though the deterministic inventories already computed are more reliable and can be aggregated by domain. At the same time, the agent-facing Generate/Repair workflow must not depend on Claude Code or any particular skill: every MCP client must be able to consume the same observations and apply its own reasoning.

## What Changes

- Refactor generation stages 1–4 into domain-scoped passes based on an aggregated deterministic representation; the LLM retains semantic synthesis, not rediscovery of structural facts.
- Keep stages 5–6 in their current aggregated form and preserve the outputs needed by OpenSpec formatting, ADRs, and existing manifests.
- Adapt `MappingGenerator` to the reconciled output and make `mapping.json` provenance/freshness explicit, preventing silent false coverage results.
- Document Generate and Repair as an agent-neutral protocol composed from existing MCP tools: OpenLore provides deterministic observations, while any host agent performs interpretation and editing, with no new MCP primitive.
- Extend the existing Pi host with a native Generate/Repair flow that consumes the same evidence layer and discloses the same limits, rather than leaving generation outside its surface.
- Replace architectural wording that makes Claude Code a required component with wording for MCP-compatible host agents.

## Capabilities

### New Capabilities

- `agent-neutral-spec-reconciliation`: a shared MCP protocol that lets any host agent generate or reconcile specs from deterministic observations.

### Modified Capabilities

- `generator`: entity, service, and API generation becomes a domain-scoped synthesis fed by reconciled deterministic evidence, and its mapping artifact remains reliable for downstream consumers.
- `mcp-handlers`: the coverage audit clearly discloses unavailable or stale mapping provenance instead of presenting misleading coverage conclusions.

## Impact

The change affects stages 1–4, the pipeline and mapping generator, audit/MCP contracts, the Pi extension, and their documentation. Public interfaces remain client- and provider-neutral; no dependency on a particular agent SDK is added.
