## Why

Real-world use of the new agent-hosted Generate and Repair workflows exposed a circular dependency on LLM-produced mapping state, misleading zero-valued coverage when that state is unusable, and completeness receipts that can be invalidated by downstream transport truncation. The same test also exposed lifecycle gaps around concurrent analysis, stale daemon caches, long silent phases, technical-domain overlap, workflow finalization, and preview fidelity.

## What Changes

- Replace the LLM-pipeline-owned requirement mapping with a deterministic spec-to-code link index derived from explicit spec anchors and the current graph. Keep `mapping.json` as a rebuildable cache, expose `openlore mapping refresh`, and let audit/Repair derive the index in memory when the cache is absent or stale.
- Preserve the public v2 API's numeric audit summary while making `mappingCoverage` its authoritative availability signal. Agent-facing MCP/composite responses represent unavailable mapping-dependent metrics as `null` with a typed reason.
- Make composite Generate/Repair responses obey a conservative serialized transport budget as well as item limits. Every omitted recoverable item receives a provenance-bound cursor, and a receipt can be `complete` only after the final transport-safe envelope is built.
- Guarantee that every advertised follow-up is callable in the active surface or provide a typed, exact CLI remediation. Remove follow-ups that merely repeat an unavailable observation.
- Bind analysis artifacts and MCP caches to one atomic analysis-generation identity, automatically reload a newer generation, and reject mixed-generation evidence.
- Serialize full analyses per repository with an inspectable lock containing PID, start time, heartbeat, and status. Report `ANALYSIS_IN_PROGRESS` distinctly and emit periodic progress during long artifact generation.
- Add deterministic overlap observations between a candidate generated domain and existing spec footprints without making a business-domain decision for the host agent.
- Make the agent-hosted Generate and Repair skills finalize successful spec edits through validation and deterministic mapping refresh, aligning their outcome with standalone generation.
- Preserve the established free, no-provider `generate --dry-run` contract (with `--plan` as an explicit alias), and add paid `--preview` for a real isolated candidate output and spec diff.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `generator`: Mapping becomes a deterministic, rebuildable spec-link artifact; hosted and standalone generation share finalization semantics; preview produces a real candidate diff.
- `mcp-handlers`: Coverage unavailability, composite pagination, follow-up recoverability, domain overlap, provenance, and cache reload behavior become transport-safe and explicit.
- `analyzer`: Full analysis gains per-repository single-flight ownership, generation identity, heartbeat, and observable in-progress state.
- `cli`: Add mapping refresh and plan/preview behavior, disclose active analysis ownership, and expose actionable lifecycle remediation.

## Impact

- Mapping artifact schema and migration, spec-reference parsing, audit summaries, Generate/Repair composite envelopes and cursors.
- MCP tool schemas, preset-aware follow-up validation, Pi rendering limits, daemon cache invalidation, and analysis preflight.
- CLI commands for mapping refresh, analysis locking/status, and generation preview.
- Canonical OpenLore Generate/Repair skills and their conformance tests.
- Existing `mapping.json` files remain safe to discard and rebuild; incompatible legacy artifacts are reported rather than trusted.
