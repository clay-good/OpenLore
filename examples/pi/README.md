# openlore × Pi

A [Pi](https://pi.dev) extension that brings openlore's deterministic structural
context into Pi — built for local models (Qwen, Gemma, …) that are strong at
using injected context but weaker at tool-calling.

It does **not** use MCP. It talks to a warm `openlore serve` HTTP daemon over
loopback, so tool calls hit warm caches and the analysis stays continuously
fresh while you edit.

## What you get

- **Context injection** (no tool call needed): each session starts grounded with
  the architecture digest (`CODEBASE.md`), the spec-domain index, and a
  task-specific `orient` on your first message.
- **Native tools**: the navigation surface as Pi tools —
  `openlore_orient`, `openlore_search_code`, `openlore_get_subgraph`,
  `openlore_trace_execution_path`, `openlore_analyze_impact`,
  `openlore_suggest_insertion_points`, `openlore_get_function_skeleton`.
- **Config wizard**: interactive setup on first run, or anytime via `/openlore`
  slash command or `openlore_configure` tool.

## Prerequisites

```bash
npm i -g openlore         # `openlore` must be on PATH
cd your-project
openlore analyze          # build the structural index at least once
```

## Install

### Recommended — Pi gallery

```bash
pi install npm:openlore
```

Pi discovers the extension automatically via the `"pi"` field in openlore's
`package.json`. On first session it launches the config wizard.

### Alternative — openlore setup

```bash
openlore setup --tools pi            # → .pi/extensions/openlore.js (this project)
openlore setup --tools pi --global   # → ~/.pi/agent/extensions/openlore.js (all projects)
```

> Requires Pi ≥ 0.78.1. The extension uses `ctx.mode` (0.78.1+) for injection
> depth: full in `tui`/`rpc` (interactive), none in `json`/`print` (one-shot).

## Configuration

On first session (no `.openlore/config.json`) the wizard runs automatically.
Re-open anytime:

```
/openlore          # slash command in any Pi session
```

or ask Pi to call `openlore_configure`.

API keys are never stored in config — set them as environment variables:

| Provider | Env var |
|----------|---------|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `openai-compat` | `OPENAI_COMPAT_API_KEY` |
| Embedding | `OPENLORE_EMBEDDING_API_KEY` |

## How it works

On `session_start` the extension looks for `.openlore/serve.json`; if no healthy
daemon is announced it spawns `openlore serve` detached and waits for `/health`.
The daemon:

- serves the `full` preset over `127.0.0.1` while Pi curates its model-visible tools,
- keeps signatures/vector fresh live, and
- re-analyzes the call graph (debounced) after each edit burst — so what the
  model sees never silently diverges from the code.

The extension never kills a daemon it didn't start; it may be serving other
clients (another Pi session, an editor). If a healthy daemon is already running
with a narrower preset, Pi reports the incompatibility and asks you to run
`openlore serve --stop`; it does not weaken that daemon's operator-selected boundary.

## Verify

```bash
# daemon is reachable
curl 127.0.0.1:$(jq .port .openlore/serve.json)/health

# a tool round-trips
curl -XPOST 127.0.0.1:$(jq .port .openlore/serve.json)/tool/orient \
  -d '{"args":{"task":"add rate limiting"}}'
```

Then run Pi in the project and confirm the session opens with openlore context
and that `openlore_orient` is callable.
