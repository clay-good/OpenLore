## Why

Telemetry from a shared repository is currently uninterpretable. Two agents worked in the same checkout — a Claude Code session and a separate agent launched from it — and the report attributed both to one caller: tools the reporting agent never invoked (`analyze_codebase`, `blast_radius`, `get_signatures`, `audit_spec_coverage`) appeared in its own statistics. `emit` (`telemetry.ts:41`) writes only a timestamp plus the payload; the MCP server captures `clientInfo` per process (`mcp.ts:2528`) but only the orient-quality metric groups by it (`telemetry.ts:100-107`). Every other aggregate — calls, errors, cache hits — is a flat sum over the file.

The same absence corrupts the behavioral metrics. `avg stale→orient latency` reported over two hours, because it pairs events across the whole file with no session boundary: one agent's stale warning matched another agent's later orientation, hours apart. A metric that measures across sessions measures nothing.

These are the metrics that are supposed to tell us whether the tool changes agent behavior. They cannot do that while a shared checkout collapses every actor into one.

## What Changes

- Stamp every telemetry event with the emitting agent (name and version) and a stable session id minted once per server process, so an event's origin is recorded at write time rather than inferred at read time.
- Compute every aggregate per agent by default — calls, errors, cache, obstinacy, recovery, orient quality — with an explicit total across agents and an `--agent` filter. Events lacking identity are reported under `unknown` and never merged into a named agent.
- Compute interval metrics only between events of the same session. A pair spanning two sessions is excluded, not averaged, and the report states how many sessions contributed and how many pairs were excluded.
- Report the sessions and agents observed, so a reader can see immediately that a repository was shared.

## Sequencing

This change lands first among the five raised by the same session, not because it is the most urgent but because it is the one that makes the other four measurable. Without per-agent, per-session attribution, a drop in advisory noise after the intent gate cannot be told apart from a second agent simply running less in the same checkout. The session that reported this only discovered that six `orient` calls attributed to it belonged to another agent by cross-checking against what it knew it had done.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `cli`: Telemetry events carry agent and session identity, aggregates are agent-scoped, and interval metrics are session-bounded.

## Impact

- `src/core/services/telemetry.ts` (identity stamping at emit; must stay non-throwing and secret-redacting).
- Every `emit` call site, via a per-process identity resolved once rather than a parameter added everywhere.
- `src/cli/commands/telemetry.ts` aggregation, rendering, and the `--agent` filter; `telemetry.test.ts` and `telemetry-tail-resilience.test.ts`.
- Existing JSONL stays readable: events without identity are attributed to `unknown` and excluded from session-bounded interval metrics rather than discarded.
