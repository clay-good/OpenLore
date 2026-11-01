# Agent-loop hooks, part 7: task creation, tool batches, Codex sub-agents

> Status: PROPOSED (2026-11-01), waiting on harness facts. Split from
> `add-agent-loop-hooks-task-created-and-compaction`, which shipped the Pi handoff after
> compaction. Each part below needs an event shape no harness documents yet; start one only when
> its event is confirmed.

## Why

| Part | Needs |
|------|-------|
| Team task created (block only, when a coordination code is blocking) | a harness event fired when a team task is created, with its description |
| After any tool batch (`PostToolBatch`) | a harness without a shell-tool matcher that has a batch event |
| Codex sub-agent start | the task text in Codex's `spawn_agent` input or `SubagentStart` payload |

## Impact

- Specs: `cli` — 1 ADDED.
- Tool surface: none added.
