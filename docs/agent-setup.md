## Agent Setup

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

Architectural context delivered passively is far more reliably absorbed and far cheaper. `openlore analyze` generates `.openlore/analysis/CODEBASE.md` for exactly this purpose: a compact, ~100-line digest that costs a fraction of what reading the equivalent source files would — and it's already pre-digested into what the agent actually needs.

When passive context isn't enough, the MCP tools replace expensive multi-file reads with a single targeted call. `orient` — the main entry point — returns relevant functions, their call neighbours, matching spec sections, and insertion-point candidates in **one round-trip** instead of a dozen `Read` calls.

### What CODEBASE.md contains

Generated from static analysis artifacts, it surfaces what an agent needs before touching code — in ~100 lines instead of reading dozens of source files:

- **Entry points** — functions with no internal callers (where execution starts)
- **Critical hubs** — highest fan-in functions (most risky to modify)
- **Spec domains** — which `openspec/specs/` domains exist and what they cover
- **Most coupled files** — high in-degree in the dependency graph (touch with care)
- **God functions / oversized orchestrators** — complexity hotspots
- **Layer violations** — if any

This is structural signal, not prose. It pairs with `openspec/specs/overview/spec.md`, which provides the functional view: what the system does, what domains exist, data-flow requirements. Together they give agents both the architectural topology and the business intent — **at the cost of two small file reads instead of an unbounded exploration loop**.

### Setup

The one-command path covers most projects:

```bash
openlore install   # detect your agent, wire it up, and build the index (no API key)
openlore doctor    # confirm it worked and see what (if anything) to fix
```

`openlore install` wires the lean `navigation` MCP surface plus the `SessionStart` and
`UserPromptSubmit` hooks, then builds the index. The granular commands below remain available
when you want project-specific context files or the workflow skills:

```bash
openlore analyze --ai-configs   # generate project-specific context files
openlore setup                   # install workflow skills
```

**`analyze --ai-configs`** generates files that are specific to this project — they reference `.openlore/analysis/CODEBASE.md` and embed the project name. Safe to re-run (skips existing files).

**`openlore setup`** copies static workflow assets from the openlore package that are identical across all projects. Run once at onboarding; re-run after upgrading openlore to get new or updated skills.

```
openlore setup [--tools vibe,cline,claude,opencode,omoa,gsd,bmad]

Mistral Vibe  ->  .vibe/skills/openlore-{name}/SKILL.md       (8 skills)
Cline / Roo   ->  .clinerules/workflows/openlore-{name}.md    (7 workflows)
Claude Code   ->  .claude/skills/openlore-{name}/SKILL.md     (8 skills + decisions pre-commit hook)
OpenCode      ->  .opencode/skills/openlore-{name}/SKILL.md   (8 skills)
              ->  .opencode/plugins/agent-guard.ts             (guard plugin)
oh-my-openagent -> .opencode/plugins/{anti-laziness,openlore-enforcer,
              ->                      openlore-decision-extractor,openlore-context-injector}.ts
              ->  .opencode/prompts/sisyphus-sdd.md            (SDD system prompt)
GSD           ->  .claude/commands/gsd/openlore-{name}.md     (2 commands)
BMAD          ->  _bmad/openlore/{agents,tasks}/               (2 agents, 4 tasks)
```

Wire the generated digest into your agent's context:

**Claude Code** — add to `CLAUDE.md`:

```markdown
@.openlore/analysis/CODEBASE.md
@openspec/specs/overview/spec.md

## openlore MCP workflow

| Situation | Tool |
|-----------|------|
| Starting any new task | `orient` — returns functions, files, specs, call paths, and insertion points in one call |
| Don't know which file/function handles a concept | `search_code` |
| Need call topology across many files | `get_subgraph` / `analyze_impact` |
| Planning where to add a feature | `suggest_insertion_points` |
| Reading a spec before writing code | `get_spec` |
| Checking if code still matches spec | `check_spec_drift` |
| Finding spec requirements by meaning | `search_specs` |
| Checking spec coverage before starting a feature | `audit_spec_coverage` |

**Follow this sequence for every task:**

1. **`orient "<task description>"`** — always start here. Returns relevant functions, files, spec domains, call paths, and insertion points in one call.
2. **If the task involves data models, APIs, or config** — call the relevant inventory tool:
   `get_schema_inventory` · `get_route_inventory` · `get_env_vars` · `get_ui_components` · `get_middleware_inventory`
3. **If debugging a call flow** ("how does X reach Y?") — `trace_execution_path`
4. **Before modifying a function** — `get_subgraph` to understand blast radius
5. **Before opening a PR** — `check_spec_drift`

**On-demand** (when orient's results aren't enough):
`search_code` · `suggest_insertion_points` · `get_spec <domain>` · `search_specs` · `analyze_impact` · `get_function_body` · `get_function_skeleton`
```

**Claude Code — MCP config (token-efficient two-server setup)**

MCP clients load all tool schemas at session start. With 66 tools, this costs ~16k tokens of `tools/list` before any work begins (Spec 28 measured it; the lossless server-side trim is only ~2%, so the real lever is deferral). Claude Code supports `alwaysLoad: false` (deferred, default) — tools load only when the agent searches for them via Tool Search.

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
- **`openlore`** exposes all 66 tools deferred — loaded on demand when the agent uses Tool Search (e.g. "find tool for BFS graph traversal"). The `--preset full` is required here: since the `default-to-lean-tool-surface` change a bare `openlore mcp` exposes only the lean 10-tool `navigation` surface, so without it the deferred server would advertise only the 10-tool navigation surface, not the full 66 you want searchable. (Deferral makes the full surface's up-front schema cost ~0, so wiring `full` on the *deferred* server is the right trade — the lean default targets the *eager* case.)

If you only need one server entry and want every tool searchable, use `alwaysLoad: false` (the default) with `openlore mcp --preset full` — all 66 tools are deferred and searchable via Tool Search. A bare `openlore mcp` instead gives the lean 10-tool navigation surface (the recommended eager default).

**Cline / Roo Code / Kilocode** — create `.clinerules/openlore.md`:

```markdown
# openlore

openlore provides static analysis artifacts and MCP tools to help you navigate this codebase.
Always use these before writing or modifying code.

## Before starting any task

- Read `.openlore/analysis/CODEBASE.md` — architectural digest: entry points, critical hubs,
  god functions, most-coupled files, and available spec domains. Generated locally by `openlore analyze`.
- Read `openspec/specs/overview/spec.md` — functional domain map: what the system does,
  which domains exist, data-flow requirements.

## openlore MCP workflow

**Follow this sequence for every task:**

1. **`orient "<task description>"`** — always start here. Returns relevant functions, files, spec domains, call paths, and insertion points in one call.
2. **If the task involves data models, APIs, or config** — call the relevant inventory tool:
   `get_schema_inventory` · `get_route_inventory` · `get_env_vars` · `get_ui_components` · `get_middleware_inventory`
3. **If debugging a call flow** ("how does X reach Y?") — `trace_execution_path`
4. **Before modifying a function** — `get_subgraph` to understand blast radius
5. **Before opening a PR** — `check_spec_drift`

**On-demand** (when orient's results aren't enough):
`search_code` · `suggest_insertion_points` · `get_spec <domain>` · `search_specs` · `analyze_impact` · `get_function_body` · `get_function_skeleton`
```

`CODEBASE.md` gives the agent passive architectural context. `overview/spec.md` gives the functional domain map. The workflow tells it exactly what to call and when, without requiring the agent to choose from a menu.

> **Tip:** `openlore analyze` prints these snippets after every run as a reminder.

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

This installs 8 workflow skills into `.opencode/skills/` and an `agent-guard.ts` plugin into `.opencode/plugins/`. OpenCode loads plugins from `.opencode/plugins/` automatically — no further configuration needed.

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

