# A conflict receipt when a team task is created (Claude Code)

> Priority: P3 · Not built · Waiting on harness facts
> Reaches the agent through: a hook moment (`task-created`, a new wiring of an existing receipt)
> Why it helps the agent: a team task that will collide with a live peer is stopped before any work starts.

## Problem

When a lead agent creates a task for a teammate, OpenLore says nothing. The peer board
(`src/core/services/footprint-board.ts`) already knows which symbols each live agent declared. A new
task that names the same symbols starts anyway, and the conflict shows up only after both agents
have edited.

The harness event for this moment is not confirmed. We do not know its payload, or whether it can
carry context or can only block. Nothing is built until that is known.

## What changes

- First, confirm the facts: capture a real Claude Code task-creation hook payload and save it as a
  test fixture. If the event does not exist or carries no task description, this change stops there.
- A new moment `task-created` in `HOOK_MOMENTS` (`src/cli/commands/hook.ts`). It resolves the task
  description to symbols with the same code as the sub-agent briefing
  (`src/core/services/subagent-briefing.ts`), and compares them to the live peer board.
- The receipt names the peer, the shared symbols, and the hazard class. It uses the existing
  finding code `parallel-work-conflict`. No new code.
- `openlore install` wires the moment for Claude Code **only when** the repository's
  `enforcement.policy` makes `parallel-work-conflict` blocking. We assume the event can only block,
  so an advisory receipt has no channel. Without that policy, the moment is not wired and is silent.

## What does not change

- No new MCP tool, command, or preset. `openlore hook <moment>` keeps its name and its other moments.
- Advisory by default: a repository with no blocking policy sees no difference.
- Local only. No network call. Works without OpenSpec.
- `hooks.task-created: false` in `.openlore/config.json` turns it off, like every moment.

## Limits we disclose

- Claude Code only. A task whose description resolves to no symbol, or to an ambiguous name, gets
  no receipt (the unique-match rule of the sub-agent briefing).
- Only peers with a live board entry are compared. A peer that never declared a footprint is not seen.
- Later, not in this change: a tool-batch event (one receipt per batch instead of per tool), Codex
  sub-agent briefings, and any other harness. Each needs an event shape that is not documented yet.

## Depends on

Shipped: the hook command, the peer board, the sub-agent briefing. Outside: a confirmed Claude Code
task-creation event.
