# `openlore install`

Auto-configure popular AI coding agents to call OpenLore's `orient()` automatically.

## Quick start

```bash
npm i -g openlore
cd your-project
openlore install
```

Once, ever. That auto-detects which agent surfaces are present (Claude Code, Cursor, Cline,
Continue, Pi, plus the universal `AGENTS.md` fallback) and writes the minimal config needed for
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

| Scope | Files (Claude Code) | Effect |
|-------|---------------------|--------|
| **user** (default) | `~/.claude.json` (`mcpServers.openlore`), `~/.claude/settings.json` (hooks + `Bash(openlore:*)`), `~/.claude/CLAUDE.md` | every repository you open reaches OpenLore |
| **repo** (always, when you run install inside one) | `.mcp.json`, `.claude/settings.json`, `.claude/settings.local.json`, `CLAUDE.md` | this repository, wired and indexed immediately |

Claude Code resolves project scope over user scope, so a repository wired explicitly keeps its own
entry. Adapters with no user-scope surface (`cursor`, `cline`, `continue`, `pi`, `agents-md`) are
wired per repository and named as such in the summary — an honest note, never a failure.
`openlore connect list` shows both scopes; `--uninstall` removes OpenLore-managed entries from
both, and never deletes `~/.claude.json` itself.

`OPENLORE_HOME` overrides where the user scope is written (sandboxes, CI images, containers whose
`$HOME` is not the profile you mean to configure).

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
- **Degrades on large trees.** Above 5,000 files the background build sheds its semantic-embedding
  pass and builds signatures plus the keyword (BM25) index only, and says so. An explicit
  `openlore analyze` is never degraded — you asked for it.

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
| `--preset <name>` | Wire the MCP server to a tool preset: `substrate` (the default — the navigation core, governance reads `recall` + `verify_claim` + `blast_radius`, and `prepare_spec_generation` + `prepare_spec_repair`; the write face `remember`/`record_decision` stays opt-in), `navigation` (the lean navigate-only escape), `minimal`, `memory`, `verify`, `federation`, `coordination`, or `full`. Omit it for the `substrate` default; pass `--preset navigation` for the lean core, or `--preset full` to wire all 76 tools. |
| `--repo-only` | Wire this repository only — write no user-scope entries. |
| `--dry-run` | Print the planned changes; write nothing. |
| `--force` | Overwrite OpenLore-managed blocks even when hand-edited. |
| `--uninstall` | Remove every OpenLore-managed block / entry. Files OpenLore created (and never had non-OpenLore content) are deleted. |

> **Default tool surface.** A plain `openlore install` wires the read-only **`substrate`** preset:
> 15 tools comprising the navigation core, the highest-value governance reads, and the 2 spec
> preparation composites. Use `--preset navigation` for the lean 10-tool escape or `--preset full`
> for all 76 tools. The decision-write and commit-gate tools remain opt-in through a preset that
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
| `pi` | `.pi/` (or `~/.pi/` when the tree has no marker at all) | write `.pi/extensions/openlore.js` — a fingerprinted re-export shim pointing at the extension inside the openlore package. No markdown block, no MCP entry: Pi does not consume MCP; the extension starts `openlore serve` on demand and injects the digest itself. See [Pi](#pi-pidev). |
| `agents-md` | always applies | append block to `AGENTS.md` (creates if absent) |

## Pi (pi.dev)

[Pi](https://pi.dev) loads JavaScript extensions rather than MCP servers, so its footprint is a
single file. Three equivalent routes, pick one:

```bash
openlore install --agent pi          # .pi/extensions/openlore.js (this project)
pi install npm:openlore              # Pi's own package route — reads the "pi" field in package.json
openlore setup --tools pi --global   # ~/.pi/agent/extensions/openlore.js (every project)
```

The extension registers the navigation tools (`openlore_orient`, `openlore_search_code`,
`openlore_get_subgraph`, …), injects `CODEBASE.md` plus a task-specific `orient` on
`session_start`, and talks to a warm `openlore serve` daemon over loopback so calls hit warm
caches. Requires Pi ≥ 0.78.1 and one `openlore analyze` beforehand. Full detail in
[`examples/pi/README.md`](../examples/pi/README.md).

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
structural navigation *and* a decision trail. Set `governance.autopilot: false` before installing
to keep the gate in blocking human-review mode instead; an explicit `false` is never flipped.

Every other git hook below is installed explicitly and is advisory by default. All of them coexist
in a single `.git/hooks/pre-commit` (each installer appends its own marked block and strips a
trailing `exit 0` so the next one stays reachable):

| Hook | Install | Blocks when |
|------|---------|-------------|
| **Enforcement gate** (recommended, unified) | `openlore enforce --install-hook` | a governance finding resolves to `blocking` under [`enforcement.policy`](configuration.md#enforcement-policy) — the single posture over all findings |
| **Agent-loop enforcement** (opt-in, Claude Code + Codex) | `openlore setup --agent-enforcement-hook all` | a finding resolves to `blocking`; remediation is fed back through each agent's Stop hook |
| Decisions gate | wired by `openlore install` in autopilot mode (never blocks); `openlore decisions --install-hook` for the explicit route | only in blocking review mode (`governance.autopilot: false`), when verified decisions await review/sync |
| Blast-radius guard | `openlore blast-radius --install-hook` | the diff triggers a configured `blastRadius.block` pattern |
| Change-impact certificate | `openlore impact-certificate --install-hook` | the diff opens a new path into a `impactCertificate.block` surface severity |

`openlore enforce` is the recommended single gate: it resolves every governance finding through one
`enforcement.policy`, and the per-surface `blastRadius.block` / `impactCertificate.block` configs lower
onto it. All hooks are advisory by default — nothing blocks until you opt a finding into `blocking`.
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
- is **gated**: exact identifier mentions, matched-function count, fan-in / hub centrality, and
  retrieval-mode evidence decide whether the task warrants a full block; below the threshold it
  degrades to a single pointer line, so injection stays out of the small/familiar arena it would
  otherwise tax. Without embeddings, the default keyword/BM25 path uses scale-free top-match
  identifier overlap and never compares the corpus-relative BM25 score to a fixed threshold. Run
  `openlore embed --local` — a one-command, on-device, no-API-key upgrade — or set `EMBED_*` for a
  remote endpoint to add the bounded semantic-score path.
- **never breaks your turn**: any failure (no graph, parse error, empty/weak match) degrades to the
  pointer line and exits 0.

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
    "tokenBudget": 600,        // hard cap in estimated tokens; positive values below 68 clamp to 68
    "relevanceMinMatches": 2,  // gate: minimum match count unless an identifier is exact
    "relevanceMinFanIn": 2,    // gate: centrality; exact/ranked identifier evidence also clears it
    "relevanceMinScore": 0.3   // gate: minimum top score (semantic/hybrid scale only)
  }
}
```

With `mode: "off"`, `openlore orient --inject` emits nothing and exits 0.

### Performance and activation notes

- **It runs on every prompt and blocks the turn until it returns**, so it is built to be fast: `orient`
  is a local, deterministic lookup (~300 ms for the work itself; the `npx` wrapper that resolves the
  package adds ~200 ms). That is well under Claude Code's 30 s `UserPromptSubmit` timeout. On a weak
  match it short-circuits to the one-line pointer, so the slow path is the rare strong-match case.
- **Activation tracks the installed version.** The wired command is `npx --yes openlore orient
  --inject`, which resolves the `openlore` your environment already has. If that is an older published
  version without `--inject`, the hook is a clean no-op (it prints nothing to stdout, writes a short
  notice to stderr, and exits non-zero — which does **not** block your prompt) until an `openlore`
  carrying `--inject` is what `npx` resolves. Run `openlore --version` to check.

## Known follow-ups

- **Continue MCP registration**: Continue's MCP config path varies across recent versions, so
  we currently only register the `/orient` slash command and leave a warning. See
  `TODO(openlore-spec-01)` in `src/cli/install/adapters/continue.ts`.
