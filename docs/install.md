# `openlore install`

Auto-configure popular AI coding agents to call OpenLore's `orient()` automatically.

## Quick start

```bash
npm i -g openlore
cd your-project
openlore install
```

Once, ever. That auto-detects which agent surfaces are present (Claude Code, Cursor, Cline,
Continue, Pi, Codex, plus the universal `AGENTS.md` fallback) and writes the minimal config needed for
each agent to call `orient()` before reading source files — **for this repository and for your
user account**. Every git repository you open afterwards with a user-scope-wired agent reaches
the OpenLore MCP server and builds its own index in the background, with no further command.

Use `--repo-only` if you want per-repository scope control instead.

Confirm it worked with `openlore doctor` — it reports your config, index freshness, MCP wiring,
and LLM/embedding setup, and prints the exact command to fix anything that is missing.

> **Onboarding onto an already-analyzed repo?** Instead of cold-indexing, import a committed graph
> bundle: `openlore import .openlore/index-bundle.olbundle` — an integrity-checked index in seconds
> (or a transparent rebuild if it is stale). Producer provenance is verified only for a trusted
> signature. See [shareable-bundle.md](shareable-bundle.md).

## Scopes: user and repository

| Scope | Files (Claude Code, Codex) | Effect |
|-------|---------------------|--------|
| **user** (default) | Claude: `~/.claude.json` (`mcpServers.openlore`), `~/.claude/settings.json` (hooks + status line + `Bash(openlore:*)`), `~/.claude/CLAUDE.md`; Codex: `~/.codex/config.toml`, `~/.codex/hooks.json` | every repository you open reaches OpenLore |
| **repo** (always, when you run install inside one) | Claude: `.mcp.json`, `.claude/settings.json` (hooks), `.claude/settings.local.json`, `CLAUDE.md`; Codex: `.codex/config.toml`, `.codex/hooks.json` | this repository, wired and indexed immediately |

The user scope is written for every adapter that *has* one, not only for adapters detected in the
current directory — that is what makes "install once" true in a repository whose markers belong to
some other agent. The practical consequence: a bare `openlore install` creates `~/.claude/` even if
you do not use Claude Code. `--repo-only`, or `--agent <name>`, avoids that.

`OPENLORE_HOME` and `OPENLORE_SETTINGS_RUNTIME_DIR` relocate the user scope and its lock/journal
directory respectively.

Adapters with no user-scope surface (`cursor`, `cline`, `continue`, `pi`, `agents-md`) are wired
per repository and named as such in the summary — an honest note, never a failure.
`openlore connect list` shows both scopes; `openlore install --uninstall` removes OpenLore-managed
entries from both, and never deletes `~/.claude.json` or `~/.claude/settings.json` themselves.
Because it removes the user scope, running it inside one repository unwires **every** repository on
the machine; it names the absolute path it stripped and says so. Use `--repo-only` to clean one
repository and leave the user scope in place. An
explicit `--agent` narrows both scopes, on install and on uninstall alike, and only a whole-install
removal takes out the commit gate. `openlore connect remove <agent>` is **repository-scoped by
default** — pass `--user-scope` to remove the machine-wide entries too.

> **Both scopes wired means both scopes active.** Claude Code resolves *MCP servers* by name, so
> one server runs. It does not do that for hooks or instructions: user-level and project-level
> `SessionStart` / `UserPromptSubmit` hooks both fire, and `~/.claude/CLAUDE.md` and the project
> `CLAUDE.md` are both loaded. A repository wired at both scopes therefore runs `orient` twice per
> session and `orient --inject` twice per prompt, and carries the instruction block twice. If that
> matters to you, wire one scope: `openlore install --repo-only` for per-repository control, or
> `openlore install --agent claude-code` from outside a repository for user scope alone.

`OPENLORE_HOME` overrides where the user scope is written (sandboxes, CI images, containers whose
`$HOME` is not the profile you mean to configure).

### Claude Code status line

When `openlore install` wires Claude Code's user scope, it also sets Claude's custom status line
(`~/.claude/settings.json` `statusLine`) to run `openlore statusline --installed-by-openlore`. The
command reports the search-index state of the OpenLore project (the nearest directory with a
`.openlore/config.json`) that contains the session's project directory, or else its current
directory. A session resumed from one started outside the project, for example in `/`, keeps that
stale project directory; the current directory then still finds the project. The status is green
when current, yellow when missing, stale, or unknown, and red when degraded. It is never written to a
repository's shared `.claude/settings.json`, which would override every teammate's own status line.
If `statusLine` is already set, install keeps it and prints a hint instead; call the unmarked
`openlore statusline` from your own status-line script to show both. Re-running install refreshes
the OpenLore status line, and uninstall removes only that one (identified by
`--installed-by-openlore`).

**While an index builds,** the status line shows its progress instead, for example
`OpenLore: indexing 45% (1,310/2,900 files)`, then the phase name (`indexing: linking`,
`indexing: writing the index`). `openlore status` shows the same line with its start time. When no
build runs, nothing extra is shown. The agent is told nothing about a build: answers served during
one already say they are partial. The progress record is `.openlore/build-progress.json`, written
at most once a second and removed when the build ends; one whose process is gone, or that has not
moved for 2 minutes, is ignored.

**With the Claude Code plugin,** OpenLore cannot set your status line (plugins have no way to). To
see build progress, wire it yourself in `~/.claude/settings.json`:

```json
{ "statusLine": { "type": "command", "command": "openlore statusline" } }
```

This needs the `openlore` CLI on your `PATH` (`npm install -g openlore`). Without it, a plugin user
sees no progress; the briefings start once the build finishes.

Claude Code documents custom shell-command status lines and ANSI color output in its
[status-line guide](https://code.claude.com/docs/en/statusline). Codex CLI's
[`/statusline` command](https://learn.chatgpt.com/docs/developer-commands#configure-footer-items-with-statusline)
currently selects and orders built-in footer fields; it does not expose a custom command or text
item, so OpenLore cannot add a dynamic readiness indicator there.

### Background auto-init, and its guardrails

Because user-scope wiring reaches repositories you never ran a command in, the background build is
consent-guarded:

- **Git work trees only.** A directory that is not inside a git work tree is never indexed.
- **Disclosed once per repository.** The first background build in a repository adds one line to
  the tool response naming what was built, where it landed, that the call was not blocked, and
  both opt-outs.
- **Opt out per repository** with `"autoInit": false` in `.openlore/config.json`, or per
  environment with `OPENLORE_NO_AUTO_ANALYZE=1`. An index-absent answer in an opted-out repository
  names the opt-out rather than reading as a broken install. `openlore features` shows the
  current state.
- **Degrades on large trees.** Above the file-count ceiling (`AUTO_INIT_DEGRADED_FILE_CEILING`, currently 5,000 files) the background build sheds its semantic-embedding pass and builds
  signatures plus the keyword (BM25) index only, and says so. An explicit `openlore analyze` is
  never degraded — you asked for it.
- **Writes no git hook.** Auto-init runs `init` and `analyze`, nothing else. The commit gate below
  is wired only by an explicit `openlore install` in that repository.

## Zero-interaction onboarding

The happy path needs no flags and never touches your repo on `npm install`:

- **Post-install hint.** Installing the package prints a single next-step line (`cd your-project && openlore install`) — no analysis, no config writes, no API key. It is silent in CI, non-TTY, and dependency/in-tree installs, and always exits 0. Suppress it with `OPENLORE_SKIP_POSTINSTALL=1`.
- **Non-interactive wiring.** `openlore connect --yes` (alias `-y`) skips the interactive agent picker and wires every detected surface, exactly like a bare `openlore install`.
- **Cold-start self-bootstrap.** If an agent wires the MCP server without ever running `openlore install`, the server builds the full index once **in the background** on first run — non-blocking, fail-soft, and with **no API key**. Opt out with `OPENLORE_NO_AUTO_ANALYZE=1`.
- **Staying current.** A passive, cached, fail-silent banner notes when a newer version is published (human-facing commands only; silenced by `OPENLORE_NO_UPDATE_NOTIFIER=1`). Upgrade explicitly with [`openlore update`](cli-reference.md#commands), which detects npm-global / Homebrew / npx and runs the right command (`--check` / `--dry-run` to preview).

## Flags

| Flag | Effect |
|------|--------|
| `--agent <name>` | Install only for one surface. Names: `claude-code`, `cursor`, `cline`, `continue`, `pi`, `agents-md`. |
| `--preset <name>` | Wire the MCP server to a tool preset: `substrate` (the default — the navigation core, governance reads `recall` + `verify_claim` + `blast_radius`, and `prepare_spec_generation` + `prepare_spec_repair`; the write face `remember`/`record_decision` stays opt-in), `navigation` (the lean navigate-only escape), `minimal`, `memory`, `verify`, `federation`, `coordination`, `plugin` (the Claude Code plugin's evidence set, with `verify_change`), or `full`. Every tool keeps its name and stays available through `--preset full` and Pi. Omit it for the `substrate` default; pass `--preset navigation` for the lean core, or `--preset full` to wire all 84 tools. |
| `--repo-only` | Wire this repository only — write no user-scope entries. |
| `--dry-run` | Print the planned changes; write nothing. Previews show only the changed hunks, in a bounded context window, with secrets redacted — an untouched key in your private configuration is never printed. |
| `--force` | Overwrite OpenLore-managed blocks even when hand-edited. |
| `--uninstall` | Remove every OpenLore-managed block / entry, in **both** scopes. Files OpenLore created (and never had non-OpenLore content) are deleted. Each reported change names its absolute path and scope, and a user-scope removal states that it affects all repositories — add `--repo-only` to uninstall this repository only. |

> **Default tool surface.** A plain `openlore install` wires the read-only **`substrate`** preset:
> 15 tools comprising the navigation core, the highest-value governance reads, and the 2 spec
> preparation composites. Use `--preset navigation` for the lean 10-tool escape or `--preset full`
> for all 84 tools. The decision-write and commit-gate tools remain opt-in through a preset that
> includes them.

## What it actually writes

Every file we touch gets a managed block delimited by:

```
<!-- BEGIN OPENLORE (managed — edits inside this block will be overwritten) -->
<!-- openlore-fingerprint: <16-hex> -->
...content...
<!-- END OPENLORE -->
```

JSON config files get a top-level `_openlore` key carrying a fingerprint of the values we wrote.
Re-running `openlore install` is a no-op when the fingerprint matches; if you hand-edited inside
the block we refuse to overwrite unless you pass `--force`.

| Surface | Marker | Files written |
|---------|--------|---------------|
| `claude-code` | `.claude/` or `CLAUDE.md` | **repo:** append block to `CLAUDE.md`; `mcpServers.openlore` in `.mcp.json`; `SessionStart` + `UserPromptSubmit` hooks in `.claude/settings.json`. **user:** the same entries in `~/.claude/CLAUDE.md`, `~/.claude.json`, `~/.claude/settings.json` |
| `cursor` | `.cursor/` or `.cursorrules` | append block to `.cursorrules`; write `.cursor/rules/openlore.mdc`; `mcpServers.openlore` in `.cursor/mcp.json` |
| `cline` | `.clinerules` or `.vscode/settings.json` (`cline.*`) | append block to `.clinerules` |
| `continue` | `.continue/` | add `/orient` entry to `.continue/config.json` (MCP server registration is TODO — see below) |
| `pi` | `.pi/` (or `~/.pi/` when the tree has no marker at all) | write `.pi/extensions/openlore.js` — a fingerprinted re-export shim pointing at the extension inside the openlore package. No markdown block or MCP entry; the extension starts `openlore serve` on demand. See [Pi](#pi-pidev). |
| `codex` | `.codex/` | add OpenLore MCP server to `.codex/config.toml` and proposal hook to `.codex/hooks.json` (or `config.toml` when it already defines hooks); in repository scope, the [agent-loop moments](#agent-loop-hooks) in `.codex/hooks.json`; user scope uses `~/.codex/`. See [Codex](#codex). |
| `agents-md` | always applies | append block to `AGENTS.md` (creates if absent) |

Plus, in any git repository, `openlore install` writes `.git/hooks/pre-commit` (the decisions gate,
non-blocking — see below) and `.git/hooks/post-commit` (its `--no-verify` bypass detector). Both are
marker-delimited blocks appended to whatever is already there, and `--uninstall` removes exactly
those blocks.

## Codex

`openlore install --agent codex` adds the OpenLore MCP server to Codex's `config.toml` and a
proposal-preparation command hook to its hooks configuration. The hook emits context only for a
recognized OpenSpec `propose` invocation; it does not parse the conversation or run structural
analysis. Codex's `UserPromptSubmit` matcher is currently ignored, so the lightweight command is
invoked on each submitted prompt and emits nothing for unrelated prompts. The agent then summarizes
the conversation and calls `openlore_orient` with that brief.

Codex requires users to review and trust non-managed hooks before they run. Project-level hooks also
require the repository's `.codex/` layer to be trusted. See [Codex hooks](https://learn.chatgpt.com/docs/hooks).

## Pi (pi.dev)

[Pi](https://pi.dev) loads JavaScript extensions rather than MCP servers, so its footprint is a
single file. Three equivalent routes, pick one:

```bash
openlore install --agent pi          # .pi/extensions/openlore.js (this project)
pi install npm:openlore              # Pi's own package route — reads the "pi" field in package.json
openlore setup --tools pi --global   # ~/.pi/agent/extensions/openlore.js (every project)
```

The extension registers the navigation tools (`openlore_orient`, `openlore_search_code`,
`openlore_get_subgraph`, …) and talks to a warm `openlore serve` daemon over loopback so calls hit
warm caches. By default it does not repeat the repository digest and spec index in each turn; the
agent calls `openlore_orient` when it has a task. Set `"pi": { "contextMode": "full" }` in
`.openlore/config.json` to restore the standing digest and index. Requires Pi ≥ 0.78.1 and one
`openlore analyze` beforehand. Full detail in
[`examples/pi/README.md`](../examples/pi/README.md).

A Pi session starts with the lean tool set Claude Code gets by default (the `substrate`
preset), plus `openlore_configure` and `openlore_activate_tools`. When Pi's native `tool_search`
is already enabled by the user, OpenLore keeps only `openlore_orient` and `openlore_search_code`
directly visible and exposes specialist tools through Pi's deferred tool search. Enable it in Pi
yourself (for example, add `"+tool_search"` to `defaultTools` in `~/.pi/agent/settings.json`);
OpenLore does not change Pi settings. Without `tool_search`, the existing lean surface and
`openlore_activate_tools` groups remain in use. To keep every tool active from the start, set:

```json
{ "pi": { "toolSurface": "all" } }
```

in `.openlore/config.json`.

Pi configuration is opt-in: an unconfigured project receives a non-blocking hint
once per cwd within the extension instance. Use `/openlore configure` for project
settings or `/openlore configure --global` for defaults shared by Pi, the CLI and
MCP in `~/.openlore/config.json` (`%USERPROFILE%\.openlore\config.json` on Windows).
Project object fields override global fields; arrays replace inherited arrays.
A project block that sets its own endpoint (`baseUrl`, `apiBase`, `openaiCompatBaseUrl`)
does not inherit the user `apiKey` or a TLS opt-out for it: a repository may not choose
where your key is sent. OpenLore prints a warning when this happens. The user file
ignores `OPENLORE_HOME`; set `OPENLORE_GLOBAL_CONFIG` to move it.
An explicit CLI `--config` uses that file alone. See
[Pi configuration](../examples/pi/README.md#configuration) for details.

> **What the file contains.** `.pi/extensions/openlore.js` is a four-line re-export shim, not a
> copy of the extension. The shipped extension is plain `tsc` output whose relative imports only
> resolve inside the openlore package, so a copy fails to load. The shim's target path is
> **absolute**: re-run `openlore install --agent pi` after moving or reinstalling openlore, and
> prefer `pi install npm:openlore` when `.pi/` is committed and shared across machines. The file
> carries an `openlore-fingerprint` marker — hand-edit it and install refuses to overwrite it
> without `--force`.

## Pre-commit hooks

`openlore install` wires **one** gate: the decisions commit gate, in non-blocking **autopilot**
mode (`governance.autopilot: true`). Verified architectural decisions are recorded and synced to
specs at commit time, and no commit is ever blocked by it. That is what makes one command yield
structural navigation *and* a decision trail.

Install sets that mode only when it wires a gate for the **first** time in a repository. A
repository that already carries an OpenLore commit gate keeps the mode it was configured with — in
a configuration that exists, an absent `governance.autopilot` means blocking review, and install
will not flip it — and an explicit `governance.autopilot: false` is never flipped either.

A repository with **no** `.openlore/config.json` at all gets a **non-blocking** gate. That is the
`openlore install --no-analyze` and `openlore setup` case: neither runs `init`, so there is nowhere
to record the mode — and blocking is a setting, so the absence of the file that would record it is
not a choice to block. Install does not create a configuration there either, because that is the
`init` you declined. To require blocking review in such a repository, run `openlore init` and set
`{ "governance": { "autopilot": false } }`.

Whichever mode is installed, install reports **that** mode: the summary is printed from the same
resolver the gate itself reads, so it cannot tell you "no commit is blocked" over a gate that
blocks.

`openlore install` also skips the gate entirely when OpenLore resolves inside the repository (a
local devDependency), because a commit gate must not execute code the repository can change.

Every other git hook below is installed explicitly and is advisory by default. All of them coexist
in a single `.git/hooks/pre-commit`. Each installer inserts its own marked block directly after
the shebang and changes nothing else in the script, so a hook of your own that ends in `exit 0`
keeps working exactly as written and still reaches every OpenLore block:

| Hook | Install | Blocks when |
|------|---------|-------------|
| **Enforcement gate** (recommended, unified) | `openlore enforce --install-hook` | a governance finding resolves to `blocking` under [`enforcement.policy`](configuration.md#enforcement-policy) — the single posture over all findings |
| **Agent-loop enforcement** (opt-in, Claude Code + Codex) | `openlore setup --agent-enforcement-hook all` | a finding resolves to `blocking`; remediation is fed back through each agent's Stop hook |
| Decisions gate | wired by `openlore install` in autopilot mode (never blocks); `openlore decisions --install-hook` for the explicit route | only in blocking review mode (`governance.autopilot: false`), when verified decisions await review/sync |
| Blast-radius guard | `openlore blast-radius --install-hook` | the diff triggers a configured `blastRadius.block` pattern |
| Change-impact certificate | `openlore impact-certificate --install-hook` | the diff opens a new path into a `impactCertificate.block` surface severity |

`openlore enforce` is the recommended single gate: it resolves every governance finding through the
one policy linked in the table, and the per-surface `blastRadius.block` / `impactCertificate.block`
configs lower onto it. All hooks are advisory by default — nothing blocks until you opt a finding into `blocking`.
Use `claude` or `codex` instead of `all` to install only one agent host; use `none` to remove
OpenLore's entries from both without changing user-authored hooks.
See [cli-reference.md](cli-reference.md#enforcement-gate).

## Task-scoped context injection

Beyond the whole-repo `SessionStart` primer, `openlore install` wires a **per-task** injection
hook (Claude Code `UserPromptSubmit`) that runs `openlore orient --inject` against your submitted
prompt and places a compact orientation block in context **before the agent's first turn**. The
orientation the agent would otherwise spend a tool round-trip to fetch is simply already there —
the round-trip is amortized to zero, which is the cost OpenLore's
[Value Scorecard](AGENT-BENCHMARKS.md) attributes the small/familiar/shallow loss case to.

The injected block:

- **reuses lean `orient` output** (Spec 27) — there is no second orientation code path;
- is **deterministic** (no LLM) and **bounded** by a token budget (default ~600 tokens), so it can
  never dominate the context it economizes;
- is **clearly attributed to OpenLore** and opens with a one-line "informational; act on it or
  ignore it" framing — facts, not instructions;
- is given **only for code the prompt names**: a `backticked` name, a file path, or an
  identifier-shaped word (camelCase, two-hump PascalCase, snake_case, CONSTANT_CASE,
  `Class.method(`). Prose is never searched, and text you paste (`<pasted_content>`) does not count.
  The block shows only what those names match **exactly** in the index, with callers; search
  neighbours are left out. A fixture or example file is shown only when you name its path, and a
  name defined in more than two files is ambiguous and skipped. Measured on 68 real prompts from
  this repository: 2 briefings, both naming a file the agent then worked on (the earlier
  keyword gate gave 25, with 4% of named files relevant).
- is **silent otherwise**: the first withheld prompt of a session gets one line saying that
  briefings come only for code the prompt names exactly; later ones get nothing. A missing index is
  stated once per session.
- **never breaks your turn**: a failure prints nothing and exits 0.

### Per-adapter support

| Surface | Pre-turn injection channel |
|---------|----------------------------|
| `claude-code` | ✅ `UserPromptSubmit` hook running `openlore orient --inject` |
| `cursor`, `cline`, `continue`, `agents-md` | ❌ no pre-turn hook mechanism — these fall back to the instruction block + `SessionStart`-style guidance; no behavior change |

### Turning it off

Task-scoped injection is on by default. To disable it (while leaving the MCP server and the
`SessionStart` primer intact), set in `.openlore/config.json`:

```jsonc
{
  "contextInjection": {
    "mode": "off",            // "task-scoped" (default) | "off"
    "tokenBudget": 600         // hard cap in estimated tokens; positive values below 68 clamp to 68
  }
}
```

With `mode: "off"`, `openlore orient --inject` emits nothing and exits 0. To turn off only this
hook moment, set `"hooks": { "prompt-submitted": false }` instead: the command then does nothing at
all (no lookup, no index build) and exits 0.

If the lookup fails, or the moment passes its 3 s time limit, the hook prints nothing and exits 0:
the agent is told nothing about OpenLore's own trouble. A withheld briefing (no named code, a
management turn, an empty prompt) prints nothing, apart from the once-per-session line above.

### Performance and activation notes

- **It runs on every prompt and blocks the turn until it returns**, so it is built to be fast: `orient`
  is a local, deterministic lookup. Measured on this repository (about 5,400 functions): about 0.1 s
  for the work itself and about 1 s for the whole process (`npm run bench:hooks`). Its time limit is
  3 s, timed from when the command has loaded; past it the hook prints nothing. That is well under
  Claude Code's 30 s `UserPromptSubmit` timeout. On a weak match it short-circuits to the one-line
  pointer, so the slow path is the rare strong-match case.
- **Activation tracks the installed version.** The wired command is `npx --yes openlore orient
  --inject`, which resolves the `openlore` your environment already has. If that is an older published
  version without `--inject`, the hook is a clean no-op (it prints nothing to stdout, writes a short
  notice to stderr, and exits non-zero — which does **not** block your prompt) until an `openlore`
  carrying `--inject` is what `npx` resolves. Run `openlore --version` to check.

## Agent-loop hooks

In a repository install, `openlore install` also wires six moments of the agent loop into
`.claude/settings.json`, so the agent gets OpenLore's receipts without calling a tool. Each runs
`openlore hook <moment>`, reads the hook payload, and prints at most one short receipt as the
event's `additionalContext` — or nothing, when there is nothing new.

| Moment | Claude Code event | What the agent is told |
|--------|-------------------|------------------------|
| `before-edit` | `PreToolUse` on `Edit\|Write\|MultiEdit\|NotebookEdit` | the target is a generated file (its source and regenerate command), vendored code, or a lockfile; an import or symbol the pending `Write`/`Edit`/`MultiEdit` text would add that does not resolve ([phantom references](phantom-references.md), graded in memory before the write) |
| `after-tools` | `PostToolUse`, same tools and `Bash`; `PostToolUseFailure` on `Bash` (a failing command) | a shell command is counted, and a test run is recorded (below); an edit is recorded for the [session ledger](session-ledger.md), which can then name background changes; new ledger facts; for the edited file: [check weakening](check-weakening.md), [phantom references](phantom-references.md), and [generated files](generated-files.md); a live peer on the [board](mcp-tools.md) that changed a symbol this worktree declared reading (`declare_footprint` `readSet`) or that `orient`/`recall` served here in the last 30 minutes |
| `before-stop` | `Stop` | the `verify_change` receipt for the session's diff, the certificates below, and the symbols edited after the last test run with the tests that reach them, shown to **you** (a `systemMessage`): context for the agent at `Stop` would make it keep working |
| `after-compact` | `SessionStart` (matcher `compact`) | the [handoff briefing](mcp-tools.md) of the in-flight change, so the agent resumes from computed state, not only the compaction summary (stated after every compaction) |
| `before-subagent` | `PreToolUse` on `Agent\|Task` | nothing: it queues the sub-agent's task (credentials redacted, kept in `.openlore/session-ledger/` for at most 2 minutes), because `SubagentStart` does not carry it; nothing is stored when `subagent-start` or `contextInjection` is off |
| `subagent-start` | `SubagentStart` | the sub-agent itself gets the task-scoped `orient` briefing for its own task, when that task is the only one queued for its session and agent type (two parallel calls of one type, or a sub-agent no `Agent` call started, get no task briefing rather than a wrong one), and the live peers of other worktrees on the board (`declare_footprint`) |

**Every finding has proof and one action.** A line from `before-edit`, `after-tools` or
`before-stop` names its proof (the file and the cited line, or the receipt that found it) and one
action, printed as labeled data: `fix` (the repair is in the agent's own diff), `decide` (a
trade-off the agent may take and record with `openlore decisions record`), or `raise` (only a person
can accept it). A finding with no proof is not printed. A note about what was not observed (no
shell command reached the hook, so test runs are not stated) carries no action.

**Certificates at stop.** `before-stop` also runs three certificates beside `verify_change`, each
only when the session's diff can give it something to find, each with its own 10 s limit and at
most 3 lines. One that fails or runs out of time prints nothing. A symbol `verify_change` already
names is not repeated.

| Certificate | Runs when the diff | States |
|---|---|---|
| `certify_public_surface` | touches a `.ts`, `.tsx`, `.js`, `.jsx` or `.py` file | each exported symbol it breaks, and the files that use it (`decide`) |
| `certify_service_contract` | touches an OpenAPI, protobuf or GraphQL file | each breaking or dangerous contract change, and its in-repository call sites (`decide`) |
| `change_impact_certificate` | — and `impactCertificate.surfaces` is set in `.openlore/config.json` | each path the change newly opens into a declared surface, never persisted (`raise`) |

**Codex.** A repository install also writes four of these moments into `.codex/hooks.json` (Codex's
hooks follow the same protocol): `before-edit` on `PreToolUse` and `after-tools` on `PostToolUse`
for `apply_patch` (every file the patch touches) and `Bash`, `before-stop` on `Stop`, and
`after-compact` on `SessionStart` (`compact`). Codex runs a new hook only after you review and trust
it. A patch's paths are read from Codex's working directory. A shell result's exit code is read
from the `Exit code:` line Codex puts at the head of its output; without one, a test run's outcome
is not known. The pending-edit check and the sub-agent moments are Claude Code only.

**Pi.** OpenLore's Pi extension appends the `after-tools` receipt to the result of Pi's `edit`,
`write`, `bash`, and `powershell` tools, so the agent reads it with the tool's own output (the
tool's machine-readable result is kept). In an OpenLore project only, it runs
`openlore hook after-tools` in a node child process (about a second and a half; at most two at
once, 20 s each, stopped on Esc), so no analyzer loads in the Pi process. A shell result's exit
code is Pi's own; an aborted or timed-out command is an interrupted run. Calls a codemode script
makes are skipped. After Pi compacts a session, the extension computes the handoff briefing
(`openlore hook after-compact`) in the background, without holding the compaction open, and adds
the latest one to the next prompt as a hidden conversation message (a turn waits at most 2 s for
it; a briefing not ready yet goes with a later turn). An overflow retry runs before it. Pi has no before-edit
or before-stop moment, so test runs recorded there are not yet stated at stop.

- **This session's changes.** Facts compare with the commit `HEAD` was at when the session's first
  hook ran, so work committed earlier is not raised again in every session.
- **Once each.** A finding is stated once per Claude Code session (keyed by the payload's
  `session_id`; without one, nothing is deduplicated), and is printed with its id, such as
  `[f:1a2b3c4d]`. Its identity is its code, its subject, and its proof: the text of the line it
  cites, without the line number, so lines added above it do not repeat it, while a change to that
  line does. The `before-stop` receipt is yours, not the agent's, so it lists each finding once
  more, for you. A fact cut by the size budget is stated on a later call. The prompt-submitted
  moment states its no-index line and its build note once per session too.
- **Found from a subdirectory.** The hook uses the nearest directory at or above the session's
  working directory whose `.openlore/` holds a `config.json` or an `analysis/`. The walk stops at
  the repository's top (`.git`) and at the home directory. The status line and the Pi extension
  use the same rule, so they report the project the hooks serve.
- **Bounded.** Each receipt has a size budget (the most severe facts first, the rest counted) and a
  time limit, timed from when the command has loaded: 3 s for the prompt moment, then 3 s, 6 s,
  20 s, 30 s, 5 s, and 10 s for the moments in the table above; past it the hook prints nothing.
  The limits come from measurement (`npm run bench:hooks`); `npm run test:budgets` fails when a
  moment's measured p95 passes its budget.
- **Upgrade, move, and uninstall.** Each hook command checks that its runtime exists first:
  `[ -f '<entry>' ] && [ -f '<node>' ] || exit 0; '<node>' '<entry>' hook <moment>` (the `npx` form
  checks `command -v npx`). So a moved or removed install makes the hooks skip themselves instead of
  failing on every event; run `openlore install` again to re-wire them. This needs a POSIX shell,
  which Claude Code uses (Git Bash on Windows). The Codex hooks are not guarded. Re-running
  `openlore install` after an upgrade leaves one group per hook and removes any group for a moment
  the new version no longer has; uninstall removes those too and leaves your own hooks unchanged.
  Uninstall keeps `.openlore/` and any skills `openlore setup` copied (they may be edited), and
  names each with the command to remove it. `openlore doctor` warns about a hook whose runtime is
  gone, and about an event that runs two different OpenLore commands for the same step (a second
  checkout, or a group an older install wrote without its marker).
- **Health, for you.** Each run that reaches the hook is recorded in
  `.openlore/session-ledger/hook-runs.jsonl` (moment, whole-process time, outcome, findings shown,
  and for an error what failed, as one line; local only, never sent, never shown to the agent).
  `openlore status` prints one `Hook health` line for the last 7 days: each moment's last run and
  p95, the errors and overruns, the most recent error's reason, and the findings shown, counted as
  fixed, decided, open, or not assessed (`hookHealth` and `hookOutcomes` in `--json`; the rules are in
  [session ledger](session-ledger.md#hook-runs-and-finding-outcomes)). With no run recorded, the line is absent. A run that never reached the hook (the CLI
  failed to load) is not counted.
- **Silent on failure.** A check that throws or does not load, a passed time limit, a missing,
  corrupt, or read-only `.openlore/`, a missing or unusable index, and an unreadable payload all end
  the same way: exit 0, nothing printed. The prompt-submitted moment (`openlore orient --inject`,
  [above](#task-scoped-context-injection)) follows the same rule, with its own off switch,
  `hooks.prompt-submitted`.
- **Advisory.** Hooks exit 0 and never block, with one exception: when your enforcement policy
  (see [pre-commit hooks](#pre-commit-hooks)) makes a finding code `blocking`, the `before-stop`
  hook blocks the stop and lists those findings for the agent. It does not block twice
  in a row.
- **User scope too.** `openlore install --scope user` wires the moments for every repository and
  worktree. Each command first checks for `.openlore/` in the project and exits before Node starts
  when there is none, so a repository that does not use OpenLore pays nothing. Where a repository
  wires a moment itself (`.claude/settings.json` or `settings.local.json`), the user-scope command
  stands down, so each event gets one receipt; `openlore doctor` does not call that pair a duplicate.
- **Edits after the last test run.** A shell command that is a test run — a runner in command
  position from a closed list (`vitest`, `jest`, `pytest`, `go test`, `cargo test`, `npm test`,
  `make test`, …) or a test script the repository declares in `package.json` (`test`, `test:*`,
  `e2e`) — is recorded with its time, exit status (a failing command arrives as a tool failure),
  and the hash of every symbol in the files the session edited. `cat jest.config.js` or
  `vitest --version` is not a run; an interrupted run does not count. At stop, the symbols whose
  hash changed since the last completed run are named (deleted ones as removed) with the tests that
  reach them, or "not computed" with the reason; a file with no record of its symbols at the run is
  named as not determined; a failed last run with no later edit is named too. Edits made through
  shell commands are not tracked. OpenLore runs no test. When no shell command ever reached the
  hook, the fact is withheld with that reason. Leading `VAR=value` assignments are dropped and
  secrets redacted before a command is stored. Other shell commands are only counted, and print
  nothing.
- **Turning one off:** `"hooks": { "before-edit": false }` in `.openlore/config.json`.
  `openlore status` lists the wired moments and marks the ones turned off.
- A `Write` payload over 8 MB is not read; the hook prints nothing for it.
- Uninstall removes only these groups (each carries `_openloreHook: <moment>`); your own hooks, and
  the opt-in `openlore check-edit --hook`, are left as they are.

Codex and Pi, and the sub-agent and task-created moments, follow in a later change.

## Known follow-ups

- **Continue MCP registration**: Continue's MCP config path varies across recent versions, so
  we currently only register the `/orient` slash command and leave a warning. See
  `TODO(openlore-spec-01)` in `src/cli/install/adapters/continue.ts`.
