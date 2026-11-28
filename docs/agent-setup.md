## Agent Setup

> **Just want the setup steps?** Run one command — see [install.md](install.md), the canonical
> setup guide (`openlore install` auto-detects and wires your agent). This page explains *why* the
> wiring helps and what an agent gains; the concrete steps live there.

Agents working on an unfamiliar codebase spend the first quarter of every session on discovery: reading files, running grep, inferring architecture from directory names. Each of those file reads costs tokens. On a large codebase, an agent can burn **tens of thousands of tokens** just answering "where do I even start?" — before writing a single line of useful code.

openlore eliminates this overhead. Run it once, wire two files into your agent's context, and every subsequent session starts with the agent already knowing:

- which functions are the highest-risk hubs to touch carefully
- where execution enters the system
- which business domains exist and what each one does
- how calls flow between files
- which specs govern which files

The agent arrives informed. No discovery pass. No token budget spent on orientation.

### Passive context vs active tools

There are two ways an agent acquires codebase knowledge:

- **Passive (zero friction, low token cost):** files listed in `CLAUDE.md` / `.clinerules` are injected at session start, before the agent processes your first message. No decision required, no tool calls, no extra round-trips.
- **Active (friction, per-call token cost):** MCP tools must be consciously selected, called, and their output integrated. Even when the information would help, agents often skip this and read files directly — it's always the safe fallback, but it's expensive.

Architectural context delivered passively is far more reliably absorbed and far cheaper. The passive part is kept small: the prompt hook prints the slim digest (`CODEBASE.slim.md`, below) once per session, and the managed block `openlore install` writes is 8 lines or fewer. `openlore analyze` also writes `.openlore/analysis/CODEBASE.md`, a ~100-line digest the agent reads when a task needs it, instead of loading it on every turn.

When passive context isn't enough, the MCP tools replace expensive multi-file reads with a single targeted call. `orient` — the main entry point — returns relevant functions, their call neighbours, matching spec sections, and insertion-point candidates in **one round-trip** instead of a dozen `Read` calls.

### What CODEBASE.md contains

Generated from static analysis artifacts, it surfaces what an agent needs before touching code — in ~100 lines instead of reading dozens of source files:

- **Entry points** — functions with no internal callers (where execution starts)
- **Critical hubs** — highest fan-in functions (most risky to modify)
- **Spec domains** — which `openspec/specs/` domains exist and what they cover
- **Most coupled files** — high in-degree in the dependency graph (touch with care)
- **God functions / oversized orchestrators** — complexity hotspots
- **Layer violations** — if any

### CODEBASE.slim.md: once per session

`openlore analyze` also writes `.openlore/analysis/CODEBASE.slim.md`: 12 lines or fewer with the
count of functions outside test, generated and vendored files and the distinct resolved
caller-callee pairs between them, up to three of them with the most callers, the languages with a
call graph, where specs and ADRs
live (only when the repository has them), and a pointer to `orient`. The prompt hook
(`orient --inject`) prints it on the first prompt of a harness session, and again only if what it
names changed (a count alone does not count) or after a compaction. It is not printed when the hook payload has no `session_id`, when
`contextInjection.mode` is `"off"`, when there is no index on this machine or the index was
imported, or when it does not fit in `contextInjection.tokenBudget` beside the task briefing (the
task briefing is kept; the summary waits for a later prompt). A `CLAUDE.md` that
`openlore analyze --ai-configs` generates names the full `CODEBASE.md` in one line instead of
`@`-importing it, but only when the prompt hook delivers the slim digest; otherwise it keeps the
import. An older generated `CLAUDE.md` keeps its import line; `openlore status` names it while the
slim digest reaches the agent, and never edits the file.

The Claude Code plugin ships five short skills: `openlore-orient`, `openlore-debug`,
`openlore-review-changes`, `openlore-write-tests`, and `openlore-implement-story`.

`CODEBASE.md` is structural signal, not prose. It pairs with `openspec/specs/overview/spec.md`, which provides the functional view: what the system does, what domains exist, data-flow requirements. Together they give agents both the architectural topology and the business intent — **at the cost of two small file reads instead of an unbounded exploration loop**.

### Setup

The one-command path covers most projects:

```bash
openlore install   # detect your agent, wire it up, and build the index (no API key)
openlore doctor    # confirm it worked and see what (if anything) to fix
```

`openlore install` wires the 15-tool read-only `substrate` MCP surface plus the `SessionStart` and
`UserPromptSubmit` hooks, then builds the index. Use `--preset navigation` for the lean 10-tool
escape. The granular commands below remain available
when you want project-specific context files or the workflow skills:

```bash
openlore analyze --ai-configs   # generate project-specific context files
openlore setup                   # install workflow skills
```

**`analyze --ai-configs`** generates files that are specific to this project — they reference `.openlore/analysis/CODEBASE.md` and embed the project name. Safe to re-run (skips existing files).

**`openlore setup`** copies static workflow assets from the openlore package that are identical across all projects. Run once at onboarding; re-run after upgrading openlore to get new or updated skills.

```
openlore setup [--tools vibe,cline,claude,opencode,omoa,gsd,bmad]

Mistral Vibe  ->  .vibe/skills/openlore-{name}/SKILL.md       (10 skills)
Cline / Roo   ->  .clinerules/workflows/openlore-{name}.md    (7 workflows)
Claude Code   ->  .claude/skills/openlore-{name}/SKILL.md     (10 skills + decisions pre-commit hook)
OpenCode      ->  .opencode/skills/openlore-{name}/SKILL.md   (10 skills)
              ->  .opencode/plugins/agent-guard.ts             (guard plugin)
oh-my-openagent -> .opencode/plugins/{anti-laziness,openlore-enforcer,
              ->                      openlore-decision-extractor,openlore-context-injector}.ts
              ->  .opencode/prompts/sisyphus-sdd.md            (SDD system prompt)
GSD           ->  .claude/commands/gsd/openlore-{name}.md     (2 commands)
BMAD          ->  _bmad/openlore/{agents,tasks}/               (2 agents, 4 tasks)
```

Wire OpenLore into your agent's context:

**Claude Code** — run `openlore install`. It writes a short managed block (8 lines or fewer) into `CLAUDE.md` and
wires the hooks that push evidence while the agent works. Do not `@`-import
`.openlore/analysis/CODEBASE.md`: it would load on every turn, and the prompt hook already gives the
agent the slim digest. A task that needs the full digest reads the file. Each MCP tool's description
says when to use it, so no tool table is needed.

**Claude Code — MCP config (token-efficient two-server setup)**

MCP clients load all tool schemas at session start. With 84 tools, this costs roughly 16k tokens of `tools/list` before any work begins (Spec 28 measured the preceding seventy-three-tool surface; the lossless server-side trim is only ~2%, so the real lever is deferral). Claude Code supports `alwaysLoad: false` (deferred, default) — tools load only when the agent searches for them via Tool Search.

The recommended setup uses two server entries: one always-visible core server and one deferred full server:

```json
{
  "mcpServers": {
    "openlore-core": {
      "type": "stdio",
      "command": "openlore",
      "args": ["mcp", "--minimal"],
      "alwaysLoad": true
    },
    "openlore": {
      "type": "stdio",
      "command": "openlore",
      "args": ["mcp", "--preset", "full"],
      "alwaysLoad": false
    }
  }
}
```

- **`openlore-core`** exposes 6 tools always visible in context (~600 tokens): `orient`, `search_code`, `record_decision`, `detect_changes`, `check_spec_drift`, `get_health_map`. These are the tools most likely to be called at session start.
- **`openlore`** exposes all 84 tools deferred — loaded on demand when the agent uses Tool Search (e.g. "find tool for BFS graph traversal"). The `--preset full` is required here: a bare `openlore mcp` exposes only the 15-tool `substrate` default surface, so without it the deferred server would advertise only those 15 tools. (Deferral makes the full surface's up-front schema cost ~0, so wiring `full` on the *deferred* server is the right trade — the eager default targets the *non-deferred* case.)

If you only need one server entry and want every tool searchable, use `alwaysLoad: false` (the default) with `openlore mcp --preset full` — all 84 tools are deferred and searchable via Tool Search. A bare `openlore mcp` instead gives the 15-tool `substrate` default surface (navigation, governance reads, and spec preparation; use `--preset navigation` for the lean 10-tool core).

The full surface stays navigable despite its size because every tool declares one of six **capability families** — `navigate` · `change` · `remember` · `verify` · `coordinate` · `federate` — carried in its MCP `annotations.family`, so a client (or Tool Search) can group rather than face a flat list. Inspect any surface grouped by family with `openlore mcp --preset full --list-tools`.

**Cline / Roo Code / Kilocode** — run `openlore install --agent cline`. It writes the same short
managed block into `.clinerules/openlore.md`. These hosts run no OpenLore hooks, so the agent calls
`openlore orient "<task>"` itself and reads `.openlore/analysis/CODEBASE.md` when a task needs it.

> **Note:** `.openlore/analysis/` is git-ignored — each developer generates it locally. Re-run `openlore analyze` after significant structural changes to keep the digest current.

**Mistral Vibe (Devstral)** — inject CODEBASE.md into Vibe's global context:

> **Vibe shows "0 skills" after setup?** Check `~/.vibe/config.toml` — if `enabled_skills` is set to a pattern like `["SKILL-*"]` (the old naming format), it won't match the new `openlore-*` names. Change it to `["openlore-*"]` or `["*"]` to load all skills.

1. Run `openlore analyze` to generate `.openlore/analysis/CODEBASE.md`
2. Append it to `~/.vibe/prompts/openlore.md` so Devstral absorbs it at every session start:

```bash
cat .openlore/analysis/CODEBASE.md >> ~/.vibe/prompts/openlore.md
```

Or install the Vibe skill (creates a `/openlore` slash command in `.vibe/skills/openlore.md`):

```bash
openlore analyze --ai-configs   # creates .vibe/skills/openlore.md
```

Then invoke `/openlore` inside Vibe to get architecture context on demand.

**OpenCode** — install skills and the agent-guard plugin:

```bash
openlore setup --tools opencode
```

This installs 10 workflow skills into `.opencode/skills/` and an `agent-guard.ts` plugin into `.opencode/plugins/`. OpenCode loads plugins from `.opencode/plugins/` automatically — no further configuration needed.

The plugin does four things at runtime, with no LLM calls of its own:

| Hook | Behaviour |
|------|-----------|
| `experimental.chat.system.transform` | Before any file change: prevents premature "Task completed". After work is done: reminds the agent to call `check_spec_drift`. |
| `tool.execute.after` | Appends a `record_decision` nudge to the output of any write/edit that touches a structural file (`service/`, `domain/`, `core/`, `adapter/`). |
| `experimental.session.compacting` | Injects pending decisions into the compaction context so they survive session summarisation. |
| `tool.definition` | Enriches the `record_decision` tool description with the known spec domains for the current project. |

**oh-my-openagent (SDD plugins)** — install four SDD-enforcement plugins for the [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) multi-model orchestration framework:

```bash
openlore setup --tools omoa
```

`setup` auto-detects an existing OMOA config and pre-checks the option. It installs four plugins into `.opencode/plugins/` and a system prompt into `.opencode/prompts/`:

| Plugin | Behaviour |
|--------|-----------|
| `openlore-context-injector.ts` | Injects a compact OpenSpec domain index into every turn (`experimental.chat.system.transform`). At session compaction, injects the full content of active-domain specs to preserve architectural contracts across summarisation. Tracks which domains the agent touched via `tool.execute.after`. |
| `openlore-enforcer.ts` | Adds a `record_decision` nudge when the agent writes structural files. Injects pending decisions at compaction. Checks the spec-drift gate on `session.idle`. |
| `openlore-decision-extractor.ts` | On `session.idle`, spawns an OMOA Librarian sub-session to extract architectural decisions from the conversation and record them via `openlore decisions`. Falls back to a plain OpenAI-compatible HTTP call if Librarian is unavailable. Skips extraction for low-centrality files using the dependency-graph scores in `.openlore/analysis/dependency-graph.json`. |
| `anti-laziness.ts` | Detects incomplete responses ("I'll let you handle…", "not possible") via `todo.updated` and `experimental.session.compacting`; reminds the agent to complete the task fully. |

Wire the SDD prompt into your OMOA config's `prompt_append` for the Sisyphus agent so it inherits the full SDD workflow on every session start.

---


## Agentic Workflows

openlore integrates with structured agentic workflows so AI agents follow a consistent process: orient → risk check → spec check → implement → drift verify.

| Integration | Description | Location |
|-------------|-------------|----------|
| **BMAD** | Brownfield agent workflow with architect + dev agents. Architect annotates stories with risk context at planning time; dev agent uses it to skip orientation on low-risk stories. | `examples/bmad/` |
| **Mistral Vibe** | Skills for Mistral-powered agents (brainstorm, implement story, debug, plan/execute refactor). Includes small-model constraints (≤50-line edits). | `examples/mistral-vibe/` |
| **GSD** | Minimal slash commands for `openlore orient` and `openlore drift` — drop into any agent that supports custom commands. | `examples/gsd/` |
| **spec-kit** | Extension layer adding structural risk analysis to any existing agent setup. | `examples/spec-kit/` |
| **Cline** | Workflow markdown files for Cline / Roo Code / Kilocode. Copy to `.clinerules/workflows/`. | `examples/cline-workflows/` |

Each integration ships with a README explaining setup and the step-by-step workflow.
