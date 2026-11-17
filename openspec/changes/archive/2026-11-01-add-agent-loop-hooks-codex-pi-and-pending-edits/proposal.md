# Agent-loop hooks, part 3: Codex, Pi, task creation, pending edits

> Status: SHIPPED (2026-11-01), pending-edit references only; the rest moved to
> `add-agent-loop-hooks-codex-and-pi`. Split from `add-agent-loop-hooks-subagents-codex-pi`, which
> shipped the Claude Code sub-agent start briefing.

## Why

| Part | Needs |
|------|-------|
| Team task created (block only, when a coordination code is blocking) | the shipped board; a harness task-created event |
| After any tool batch (`PostToolBatch`): test runs for the session ledger | other harnesses (Claude Code is covered by the after-tools `Bash` matcher) |
| Before an edit: phantom references graded on the pending text | an in-memory `checkPhantomReferences` (today it reads the file from disk) |
| Codex (`PreToolUse`, `PostToolUse`, `SessionStart`, `SubagentStart`) and Pi (`tool_call`, `tool_result`, `session_before_compact`, `before_agent_start`) | adapters; Codex keeps `hooks.json` or `config.toml`, Pi calls in-process |

## What changes

The requirement below, using the shipped `openlore hook` command and its rules (silent when empty,
dedupe by `session_id`, budgets, fail-open, opt-in blocking, `hooks.<moment>` opt-out).

## Impact

- Specs: `cli` — 1 ADDED.
- Tool surface: none added.
