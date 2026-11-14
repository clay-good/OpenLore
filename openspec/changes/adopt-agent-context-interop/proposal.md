# Five short skills and a slim digest for the Claude Code plugin

> Priority: P2 · Not built
> Reaches the agent through: the prompt-submitted moment (slim digest), and plugin skills that call `orient`, `blast_radius`, `verify_change`, `verify_claim`, and `recall`
> Why it helps the agent: the agent gets a few lines of repository shape once per session and five short recipes, not a long file on every turn.

## Problem

An npm install tells the user to `@`-import `.openlore/analysis/CODEBASE.md` into `CLAUDE.md`. That
file is the full digest from `generateCodebaseDigest` (`src/core/analyzer/codebase-digest.ts`): hub
tables, entry points, god functions, ownership domains. It is loaded on every turn, whether or not
the task needs it. A plugin install cannot edit `CLAUDE.md`, so a plugin user gets no digest at all.

The plugin ships one skill, `openlore-orient`. The other canonical skills in `skills/` are long
(132 to 352 lines) and some name tools that the default `substrate` surface does not expose. The
agent has no short recipe for "debug this," "review my change," or "which tests do I write."

## What changes

- **A slim digest.** `generateCodebaseDigest` also writes `.openlore/analysis/CODEBASE.slim.md`
  (new file): at most 12 lines. It holds the function and edge counts, the three highest fan-in
  hubs, the languages with a call graph, where specs and decisions live (when the repository has
  any), and one pointer line to `orient`. Repository-derived lines go through
  `frameServedContent`, like the full digest.
- **Printed once per session at the prompt-submitted moment.** `buildInjection`
  (`src/cli/commands/orient-inject.ts`) puts the slim digest before the task block on the first
  prompt of a session. It records the delivery under the payload's `session_id` in the per-session
  record that `src/core/services/hook-session.ts` keeps (hook-reliability task 3.1), so later prompts do not repeat it. A rebuilt
  index with a different digest is printed once more. No `session_id`: the digest is not printed.
- **Five plugin skills.** The plugin ships `openlore-orient`, `openlore-debug`,
  `openlore-review-changes`, `openlore-write-tests`, and `openlore-implement-story`. Each `SKILL.md`
  in `skills/` is cut to 80 lines or fewer, names only tools in the `plugin` preset, and ends
  with one of three actions: fix it, record a decision with the proof, or raise it to the human.
  The copies under `plugin/skills/` are byte-identical to `skills/`.
- **A guard test** pins the skill list, the line budgets, the tool names, and the digest size.

## What does not change

- No new tool, preset, command, or config key. `contextInjection.mode: "off"` also turns the slim
  digest off.
- `CODEBASE.md` keeps its name, content, and the `@`-import that `openlore install` writes. Current
  npm, MCP, and Pi users see no difference. Pi keeps `pi.contextMode`.
- `openlore setup` still installs the full skill set for the harnesses it supports.
- Local only, no LLM. Works with no spec framework: the spec and decision line is left out when the
  repository has none.

## Limits we disclose

- The slim digest is a fixed-size summary. It names three hubs, not all of them; the pointer line
  says to call `orient` for the task.
- "Once per session" depends on the harness sending `session_id`. Without it, nothing is printed.
- Until the first index build finishes there is no digest. The existing pointer line says so.
- `AGENTS.md` as the default context file, and skills for other harnesses, are not in this change.
  They are later work.

## Depends on

- `ship-claude-code-plugin` (separate change, folder `plugin/`): it builds the plugin, its hooks,
  and the copy of `openlore-orient`. This change only sets the skill content and the digest.
- Shipped: `generateCodebaseDigest`, `orient --inject`, the per-session hook record.
