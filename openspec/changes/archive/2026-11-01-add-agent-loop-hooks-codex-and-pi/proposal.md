# Agent-loop hooks, part 4: Codex, Pi, task creation

> Status: SHIPPED (2026-11-01), Codex only; Pi and the rest moved to
> `add-agent-loop-hooks-pi-and-task-created`. Split from `add-agent-loop-hooks-codex-pi-and-pending-edits`,
> which shipped pending-edit reference grading.

## Why

Claude Code gets every agent-loop moment; Codex and Pi get none, and no harness gets a receipt when
a team task is created.

| Part | Needs |
|------|-------|
| Codex (`PreToolUse`, `PostToolUse`, `SessionStart`, `SubagentStart`) | a hooks adapter; Codex keeps `hooks.json` or `config.toml` |
| Pi (`tool_call`, `tool_result`, `session_before_compact`, `before_agent_start`) | in-process calls from the Pi extension |
| Team task created (block only, when a coordination code is blocking) | a harness task-created event |
| After any tool batch (`PostToolBatch`): test runs for the session ledger | harnesses without a shell-tool matcher |

## What changes

The requirement below, using the shipped `openlore hook` command and its rules.

## Impact

- Specs: `cli` — 1 ADDED.
- Tool surface: none added.
