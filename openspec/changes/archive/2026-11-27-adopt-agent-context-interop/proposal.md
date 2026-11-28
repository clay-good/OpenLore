# Five short skills and a slim digest for the Claude Code plugin

> Priority: P1 · Built (archived with the PR that built it)
> Reaches the agent through: the prompt-submitted moment (slim digest), and plugin skills that call `orient`, `blast_radius`, `verify_claim`, `recall`, and the other navigation tools the plugin wires
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
  (new file): at most 12 lines. It holds the count of functions outside test, generated and
  vendored files, the distinct resolved caller-callee pairs between them, up to three of them with
  the most callers (two or more, no arbitrary pick from a tie), the
  languages with a call graph, where specs and ADRs live (when the repository has any), and one
  pointer line to `orient`. The facts sit inside a `frameServedContent` frame, and each fact line
  follows a fixed grammar (numbers, plain names, plain paths, registered languages), so no sentence
  from the repository fits. Every analyze path (CLI, MCP, API) writes it after it publishes an
  index, and the CLI's "up to date" path rebuilds one that is missing or out of date.
- **Printed once per session at the prompt-submitted moment.** `injectOutput`
  (`src/cli/commands/orient.ts`, where the hook's `session_id` is known) puts the slim digest before
  the task block on the first prompt of a session. It records the delivery in the per-session
  record that `src/core/services/hook-session.ts` keeps, so later prompts do not repeat it. A
  digest that names something new (numbers alone do not count), or one lost to a compaction, is
  printed once more. It is not printed without a
  `session_id`, without an index on this machine, for an imported index, or for a file that is not
  byte-for-byte what `openlore analyze` writes. Sub-agent briefings (`buildInjection`) do not carry it.
- **Five plugin skills.** The plugin ships `openlore-orient`, `openlore-debug`,
  `openlore-review-changes`, `openlore-write-tests`, and `openlore-implement-story`. Each `SKILL.md`
  in `skills/` is cut to 80 lines or fewer, names only tools that both the `plugin` preset and the preset `plugin/.mcp.json` wires expose, and ends
  with one of three actions: fix it, record a decision with the proof, or raise it to the human.
  The copies under `plugin/skills/` are byte-identical to `skills/`.
- **A guard test** pins the skill list, the line budgets, the tool names, and the digest size.

## What does not change

- No new tool, preset, command, or config key. `contextInjection.mode: "off"` also turns the slim
  digest off.
- `CODEBASE.md` keeps its name and content. This change does not remove the `@`-import that a
  generated `CLAUDE.md` holds; `trim-standing-agent-instructions` replaces it with a path pointer
  once the slim digest exists. Pi keeps `pi.contextMode`.
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

## Used by

- `trim-standing-agent-instructions`: drops the full-digest `@`-import once this slim digest ships.
- `add-session-catch-up-briefing`: prints its catch-up in the same once-per-session block, after the
  slim digest. Task 2.3's budget rule covers both: the task block is kept first, then the digest,
  then the catch-up.
