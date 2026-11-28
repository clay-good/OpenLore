# Cut the standing instructions to a few lines

> Priority: P1 · Built (archived with the PR that built it)
> Reaches the agent through: the instruction files the harness loads on every turn (`CLAUDE.md`, `AGENTS.md`), and the MCP tool list
> Why it helps the agent: it spends its context on the task, not on reading how OpenLore works before it does any work.

## Problem

Before the agent does any work, it reads text about OpenLore. Measured on 2026-11-27 (main at e6d63d915):

| Source | Size | Loaded |
|--------|------|--------|
| `.openlore/analysis/CODEBASE.md`, `@`-imported by the generated `CLAUDE.md` (`buildContent`, `src/core/analyzer/ai-config-generator.ts:221`) | 11,126 bytes | every turn |
| The managed block (`src/cli/install/templates/agent-instructions.md`) | 1,512 bytes | every turn, once per scope; a user-scope and a project install load it twice |
| `## openlore MCP workflow` (`buildMcpSection`, same file) | about 40 lines | every turn |
| 15 MCP tool descriptions over 800 characters (ROADMAP P0 row) | — | every session |

Most of it explains tools the agent can list itself, or it is repository shape the agent needs only
for some tasks. The hooks already push evidence when it is relevant, so the standing text tells the
agent to do work that OpenLore now does by itself.

## What changes

- **A short managed block.** `agent-instructions.md` becomes 8 lines or fewer. It says: OpenLore
  pushes evidence through hooks, and no output means nothing new; call `orient` for an unfamiliar
  area; record a design choice with `openlore decisions record`. It names no tool the wired preset
  does not expose (today's `align-generated-guidance-with-installed-preset` rule stays).
- **No full digest on every turn.** A newly generated `CLAUDE.md` no longer `@`-imports
  `CODEBASE.md`. The slim digest from `adopt-agent-context-interop` reaches the agent once per
  session through the prompt hook. `CODEBASE.md` is still written, and the block names its path
  in one line for a task that needs it.
- **A short workflow section.** `buildMcpSection` keeps the `orient` line and the decisions line.
  The situation table goes; the MCP tool descriptions already carry it.
- **Tool descriptions at most 800 characters.** The 15 long descriptions are cut. A guard test
  fails when a description in `TOOL_DEFINITIONS` passes 800 characters. This closes the P0 row.
- **This repository dogfoods it.** The OpenLore repository's own `CLAUDE.md` (33 KB) drops its
  tool table and points to `docs/mcp-tools.md`, so agents that build OpenLore see what users see.

## What does not change

- No tool, command, flag, preset, or config key is added, removed, or renamed.
- A file the user wrote is not rewritten. `generateAiConfigs` still writes only absent files; the
  managed block is replaced only inside its markers, as today. An `@`-import the user keeps outside
  the markers stays.
- `CODEBASE.md` keeps its name and content. Pi keeps `pi.contextMode`.
- Local only, no LLM, no spec framework needed.

## Limits we disclose

- A `CLAUDE.md` that an older version created holds the `@`-import outside any marker, so this
  change does not remove it. `openlore status` names the line and its size once, with the command
  to delete it; it does not edit the file.
- The block is not deduplicated across user and project scope. At 8 lines the copy costs little,
  and the project copy is what teammates without a user-scope install see.

## Depends on

- `adopt-agent-context-interop` (shipped): the slim digest `CODEBASE.slim.md` and its once-per-session
  delivery. Every analyze path writes it, so dropping the `@`-import loses no repository shape.
