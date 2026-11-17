# Agent-loop hooks, part 5: Pi, task creation, Codex sub-agents

> Status: SHIPPED (2026-11-01), the Pi after-edit receipt only; the rest moved to
> `add-agent-loop-hooks-task-created-and-compaction`. Split from `add-agent-loop-hooks-codex-and-pi`, which shipped the
> Codex moments.

## Why

| Part | Needs |
|------|-------|
| Pi: after-edit receipt appended to the `tool_result` content of `edit`/`write`/`bash`; handoff at `session_before_compact` | the Pi extension stays dependency-light (no analyzer in the Pi process): the receipt must come from the daemon or a spawned `openlore hook` |
| Team task created (block only, when a coordination code is blocking) | a harness task-created event |
| After any tool batch (`PostToolBatch`) | harnesses without a shell-tool matcher |
| Codex sub-agent start | the `spawn_agent` input's task field (not yet confirmed) |

## Impact

- Specs: `cli` — 1 ADDED.
- Tool surface: none added.
