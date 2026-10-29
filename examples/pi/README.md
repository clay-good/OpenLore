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
- **Native tools**: a session starts with the same lean set Claude Code gets
  by default (the `substrate` preset) — `openlore_orient`,
  `openlore_search_code`, `openlore_get_subgraph`, `openlore_analyze_impact`,
  `openlore_recall`, `openlore_verify_claim`, `openlore_blast_radius`, and more.
  The agent calls `openlore_activate_tools` to turn on a group when a task needs
  it: `specs` (including `openlore_prepare_spec_generation` and
  `openlore_prepare_spec_repair`), `memory`, `review`, `quality`, or `inspect`. Set
  `"pi": { "toolSurface": "all" }` in `.openlore/config.json` to keep every tool
  active.
- **Config wizard**: opt-in setup via `/openlore configure`
  slash command or `openlore_configure` tool.
- **Footer status**: an `openlore:` entry in Pi's status bar says whether the
  tools can work right now. It uses Pi's theme colors to distinguish ready,
  in-progress, warning, and error states. See [Status line](#status-line).

## Prerequisites

```bash
npm i -g openlore         # `openlore` must be on PATH
cd your-project
openlore analyze          # build the structural index at least once
```

## Install

### Recommended — openlore install

```bash
openlore install --agent pi   # → .pi/extensions/openlore.js (this project)
openlore connect pi           # same thing, from the interactive connect surface
```

Pi is a first-class `openlore install` surface: a bare `openlore install` detects it
from `.pi/` (or `~/.pi/` when the tree carries no agent marker at all) and wires it
alongside your other agents. `--dry-run`, `--force`, and `--uninstall` all apply.

The installed file is a re-export shim, not a copy: the shipped extension is plain
`tsc` output whose relative imports resolve only inside the openlore package, so a
copy throws `Cannot find module '../cli/commands/orient-inject-render.js'` when Pi
loads it. The shim's target path is absolute — re-run install after moving or
reinstalling openlore. If `.pi/` is committed and shared across machines, use the Pi
gallery route below instead.

### Pi gallery

```bash
pi install npm:openlore
```

Pi discovers the extension automatically via the `"pi"` field in openlore's
`package.json`. Unconfigured projects receive a non-blocking configuration hint.

### All projects — openlore setup --global

```bash
openlore setup --tools pi --global   # → ~/.pi/agent/extensions/openlore.js (all projects)
```

> Requires Pi ≥ 0.78.1. The extension uses `ctx.mode` (0.78.1+) for injection
> depth: full in `tui`/`rpc` (interactive), none in `json`/`print` (one-shot).

## Configuration

Configuration is opt-in. Without project configuration or user defaults, startup
shows a hint once per cwd during the extension's lifetime and never waits for a
dialog. Open the wizard explicitly:

```
/openlore configure           # this project
/openlore configure --global  # defaults for all projects
```

or ask Pi to call `openlore_configure` (with `global: true` for user defaults).
The bare `/openlore` command remains a project-wizard alias.

User defaults live in `~/.openlore/config.json` (`%USERPROFILE%\.openlore\config.json`
on Windows). Pi, the CLI and MCP share these defaults. Object fields merge with
`.openlore/config.json` in the current project; project values take priority, and
project arrays replace global arrays. An explicit CLI `--config` or API config
path uses that file alone. Ordinary saves write project configuration;
`configure --global` writes only the user file and does not offer project analysis.
`OPENLORE_GLOBAL_CONFIG` selects another user-defaults file for an isolated host.
Set `"embedding": null` in project configuration to disable inherited embeddings;
the project wizard's Remove embedding action writes this override when needed.

For example, a global file can contain:

```json
{
  "generation": { "provider": "openai", "model": "your-model" },
  "pi": { "toolSurface": "lean" },
  "contextInjection": { "mode": "task-scoped" }
}
```

Projects can override just the model while retaining the global provider. Changing
the provider drops inherited provider-specific model, endpoint and TLS settings.
Relative paths still resolve within each project; analysis artifacts remain local.

API keys are never stored in config — set them as environment variables:

| Provider | Env var |
|----------|---------|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `openai-compat` | `OPENAI_COMPAT_API_KEY` |
| Embedding | `OPENLORE_EMBEDDING_API_KEY` |

## Status line

In the TUI and RPC modes, the extension shows one `openlore` entry in Pi's
footer. It is set at session start and after each agent run. It is cleared on
shutdown. Print (`-p`) and JSON modes show no status.

| Status | Meaning |
|--------|---------|
| `openlore: connecting…` | The session is finding or starting the daemon. |
| `openlore: ready` | The index is whole and the daemon can serve tools. |
| `openlore: ready (watcher stopped)` | Ready, but the daemon reports that its freshness watcher stopped: edits are not re-indexed until the daemon restarts. |
| `openlore: no index (run openlore analyze)` | The repository has no analysis yet. |
| `openlore: analyzing…` | An analysis owns the repository and no usable index exists yet. |
| `openlore: index degraded` | An analysis artifact is missing or corrupt. Run `openlore analyze`. |
| `openlore: daemon incompatible` | A daemon from an older release or with an outdated tool surface runs for this tree. Pi automatically replaces a verified older-version daemon when the project is opened, reusing its preset. A current-version preset missing Pi tools remains in place and shows an explicit full-preset recovery command. |
| `openlore: daemon not started (spawn disabled)` | `OPENLORE_PI_NO_SPAWN` or `"pi": { "spawnDaemon": false }` is set and no daemon is running. |
| `openlore: daemon unavailable` | The daemon could not start or stopped answering. See `.openlore/serve.log`. |
| `openlore: status unknown` | The readiness read failed. Tools still report their own errors. |

The status never says `ready` unless both the index and the daemon are
usable. Between agent runs the status can be old; the next run updates it.

## How it works

On `session_start` the extension looks for `.openlore/serve.json`; if no healthy
daemon is announced it spawns `openlore serve` detached and waits for `/health`.
The daemon:

- serves the `full` preset over `127.0.0.1` while Pi curates its model-visible tools,
- keeps signatures/vector fresh live, and
- re-analyzes the call graph (debounced) after each edit burst — so what the
  model sees never silently diverges from the code.

After an update, detached daemons from the previous release can survive
restarting Pi or pi-outpost. When a project is opened, Pi automatically replaces
an authenticated daemon whose reported version is older than the installed extension,
reusing the preset reported by its authenticated health response. The newly installed
release applies that preset's updated tool definition. If a current-version preset still
lacks tools Pi needs, Pi reports the incompatibility without repeatedly restarting it;
`/openlore restart` explicitly switches to Pi's full preset. The
stop uses the packaged CLI, so `openlore` need not be installed globally or on
`PATH`. It verifies the daemon's repository,
PID, protocol, and authentication and waits for graceful teardown; it never sends
a signal to a PID from `serve.json`. If shutdown is refused or incomplete, no
replacement is launched. An unverified or legacy daemon must be stopped by its owner.

For an explicit retry, run **`/openlore restart`** in Pi or pi-outpost while the
agent is idle. This can interrupt other clients sharing the project daemon.

When `OPENLORE_PI_NO_SPAWN` or `pi.spawnDaemon: false` is set, automatic recovery
and the explicit restart command refuse both stopping and starting: use the
supervising host's restart mechanism instead.

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
