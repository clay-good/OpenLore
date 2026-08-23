## Context

The live MCP server builds `tools/list` from `TOOL_DEFINITIONS`, a selected preset, and
`toolAnnotations`. Existing byte ceilings do not express a stable token-regression unit, and the
CLI commands that overlap MCP tools historically called handlers outside the common dispatch
boundary. See `proposal.md` for motivation and `specs/mcp-quality/spec.md` for the required behavior.

## Goals / Non-Goals

**Goals:**

- Measure the exact served tool-list object with one deterministic, offline algorithm.
- Keep immutable adoption baselines and reviewed preset ceilings beside the preset definitions.
- Make successful paired CLI conclusions cross the same contract/redaction boundary as MCP.
- Guard the common input projection and declare face-only capabilities and controls.

**Non-Goals:**

- Predict provider-specific billing tokens or add a tokenizer dependency.
- Make CLI and MCP transport envelopes identical. MCP byte capping, protocol errors, human output,
  and CLI exit policy remain transport concerns.
- Add tools, remove tools, or change preset membership.

## Decisions

### Measure the exact live payload through a shared builder

`buildToolListPayload` constructs the object returned by the MCP `tools/list` handler, including
annotations and any current or future schema fields carried by a tool definition. Tests call the
same builder instead of maintaining a measurement-only projection. This prevents live wire growth
from bypassing the budget. A duplicated schema projection was rejected because it can drift while
both implementations remain internally consistent.

### Use a versioned UTF-8 approximation

`utf8-bytes-div-4-v1` serializes the payload in registry order and computes
`ceil(Buffer.byteLength(json, 'utf8') / 4)`. The unit is stable, dependency-free, and suitable for
relative regression gates. A provider tokenizer was rejected because it adds network/package
coupling and would falsely imply portability across models. Any change to serialization or
arithmetic requires a new version and new adoption baselines.

### Separate immutable baselines from enforceable ceilings

Each preset records `baselineTokens`, `maxTokens`, and a rationale stating the headroom adopted on
2026-08-23. The baseline stays historical; live measurements may move within the ceiling. CI gates
only `measuredTokens > maxTokens`, while validating that the ceiling and rationale remain bounded
to at most 10% over the adoption baseline. This gives ordinary edits usable headroom without
letting a future ceiling raise masquerade as baseline drift.

### Define parity at the semantic dispatch boundary

Paired CLI JSON paths call `dispatchTool`, the same boundary used by MCP, so conclusion-shape
enforcement and source redaction happen once. Behavioral tests pass non-default common inputs and a
receipt-bearing result through every pair, while a real indexed-search fixture exercises the
unmocked dispatcher. Registry tests classify MCP-only and CLI-only conclusions and compare each
pair's declared common/MCP-only input keys with the live MCP schema. MCP response byte capping,
protocol error envelopes, CLI availability envelopes, human rendering, and exit codes remain
outside semantic parity because they are transport policy rather than handler conclusions.

## Risks / Trade-offs

- **[Approximation differs from a provider tokenizer]** → Publish the algorithm and call values
  estimated regression tokens, never billing tokens.
- **[Serialization order changes the estimate]** → Preserve deterministic registry order and pin
  the algorithm version; treat a version change as a reviewed re-baseline.
- **[A budget is raised to absorb accidental growth]** → Keep the adoption baseline immutable,
  require a rationale tied arithmetically to it, and cap initial headroom at 10%.
- **[A paired surface gains an input on one face]** → Compare declared projections with the live MCP
  schemas and exercise exact CLI argument forwarding with non-default values.
- **[Transport behavior is mistaken for conclusion parity]** → State the pre-transport boundary in
  the spec and docs and retain each transport's existing error, cap, and exit semantics.

## Migration Plan

Land the shared builder, budgets, guards, parity routing, documentation, and canonical spec delta in
one release. No stored data or user configuration changes. Rollback is a normal commit revert; tool
names, preset membership, and public success-result schemas are unchanged.
