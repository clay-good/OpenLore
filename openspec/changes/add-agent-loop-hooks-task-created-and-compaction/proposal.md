# Agent-loop hooks, part 6: task creation, Pi compaction, Codex sub-agents

> Status: PROPOSED (2026-11-01). Split from `add-agent-loop-hooks-pi-and-task-created`, which
> shipped the Pi after-edit receipt.

## Why

| Part | Needs |
|------|-------|
| Pi: handoff briefing before a compaction (`session_before_compact`) | the shape Pi accepts from that event |
| Team task created (block only, when a coordination code is blocking) | a harness task-created event |
| After any tool batch (`PostToolBatch`) | harnesses without a shell-tool matcher |
| Codex sub-agent start | the `spawn_agent` input's task field (not yet confirmed) |

## Impact

- Specs: `cli` — 1 ADDED.
- Tool surface: none added.
