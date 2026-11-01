# Agent-loop hooks, part 2: sub-agents, task creation, Codex and Pi

> Status: SHIPPED (2026-11-01), sub-agent start only; the other parts moved to
> `add-agent-loop-hooks-codex-pi-and-pending-edits`. Originally proposed 2026-10-31. Split from `add-agent-loop-hook-surfaces`, whose `openlore hook`
> command and Claude Code before-edit, after-edit, and before-stop moments shipped first, and the
> after-compact moment shipped with `add-session-handoff-briefing`. Each part below needs a receipt
> or an adapter that has not shipped.

## Why

| Part | Needs |
|------|-------|
| Sub-agent start: task-scoped `orient` + peers' footprints | `add-peer-footprint-board` (the `orient` half can ship alone) |
| Team task created (block only, when a coordination code is blocking) | `add-peer-footprint-board` |
| After any tool batch (`PostToolBatch`): test runs for the session ledger | `add-session-ledger-runs-contracts-tokens` (shipped for Claude Code through the after-tools `Bash` matcher; other harnesses here) |
| Before an edit: phantom references graded on the pending text | an in-memory `checkPhantomReferences` (today it reads the file from disk) |
| Codex (`PreToolUse`, `PostToolUse`, `SessionStart`, `SubagentStart`; no `Stop` by default: it cannot inject) and Pi (`tool_call`, `tool_result`, `session_before_compact`, `before_agent_start`) | adapters; Codex keeps `hooks.json` or `config.toml`, Pi calls in-process |

## What changes

The requirement below, using the shipped `openlore hook` command, its rules (silent when empty,
dedupe by `session_id`, budgets, fail-open, opt-in blocking, `hooks.<moment>` opt-out), and the
`_openloreHook` group marker.

## Impact

- Specs: `cli` — 1 ADDED.
- Tool surface: none added.
