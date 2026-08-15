## 1. Identity at emit time

- [x] 1.1 Add a process-scoped telemetry identity (agent name, agent version, session id) resolved once and readable by `emit`, so no call site needs a new parameter.
- [x] 1.2 Set the identity from the MCP `clientInfo` capture in `src/cli/commands/mcp.ts`, and from the command name for CLI-originated events.
- [x] 1.3 Stamp identity onto every event in `telemetry.ts:emit`, keeping the function non-throwing and preserving secret redaction.
- [x] 1.4 Tests: two processes emit distinct session ids; a throwing identity source degrades to `unknown` without affecting the caller.
- [x] 1.5 Treat identity-less events as one implicit `legacy-unattributed` session under `unknown`: historical data keeps its metrics, a legacy event never pairs with an identified one, and the assumption is stated in the report.

## 2. Agent-scoped aggregation

- [x] 2.1 Group call, error, and cache aggregates by agent in `src/cli/commands/telemetry.ts`, alongside the existing per-agent orient quality.
- [x] 2.2 Add an explicit cross-agent total, distinct from any single agent's figures.
- [x] 2.3 Add an `--agent` filter and report the observed agents and session count.
- [x] 2.4 Attribute identity-less legacy events to `unknown`; never merge them into a named agent.

## 3. Session-bounded interval metrics

- [x] 3.1 Pair interval-metric events only within one agent session; count and report excluded cross-session and cross-agent candidates.
- [x] 3.2 Report contributing session count per interval metric, and an explicit no-qualifying-pair state instead of a value.
- [x] 3.3 Tests: a cross-session pair is excluded; a within-session pair is measured; an empty sample renders as such.

## 4. Verification

- [x] 4.1 Run the telemetry command tests, including tail resilience across rotation.
- [x] 4.2 Replay a two-agent JSONL fixture and confirm no tool crosses between agents and no interval metric spans sessions.
