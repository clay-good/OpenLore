# One-command, idempotent agent onboarding (`openlore connect`)

> Status: IMPLEMENTED — shipped on branch `feat/recall-deterministic-ranking` (PR #161). Ships in **v2.1.0**.
> Delivered by **enhancing the existing `openlore install` engine and adding a thin `connect`
> front-end**, not by building a parallel system. See "Implementation status" at the foot of this file.

## Why

OpenLore's onboarding was capable but had real gaps. The wiring engine — `openlore install` — already
had an adapter-per-agent design (claude-code, cursor, cline, continue, agents-md), **idempotent
sentinel-delimited markdown injection with hand-edit detection** (`block.ts`), MCP-server + SessionStart
hook registration, and `--uninstall` / `--dry-run` / `--force`. Two things were missing, and a third
was a discoverability/UX gap:

1. **No preset awareness.** The registered MCP server was always the full ~45-tool surface; there was
   no way to wire a curated `--preset` (e.g. `memory`) into what the agent sees.
2. **No run permission.** Nothing granted the agent permission to invoke the `openlore` CLI, so every
   call could prompt.
3. **No discoverable verb or status view.** "install" doesn't read as "connect my agent," and there
   was no way to ask "which agents are wired here, and which aren't?"

(The separate `analyze --ai-configs` path *does* write-once-and-skip — genuinely not idempotent — but
the `install` engine, which `connect` builds on, was already idempotent. So the proposal's original
"#1 gap" was already solved on the path that matters.)

## What changed

Rather than duplicate the adapters, `markdown-block.ts`, and `json-managed.ts` in a new command, this
change **closes the gaps in the shared engine and fronts it with `connect`:**

1. **`--preset` on the engine (PresetAwareConnect).** `install` / `connect` accept `--preset <name>`,
   validated against the real `TOOL_PRESETS`. The claude-code and cursor adapters thread it into the
   registered server as `openlore mcp --preset <name>`. No preset = today's full surface (unchanged).

2. **Run-permission wiring (CapabilityGatedWiring).** The claude-code adapter adds `Bash(openlore:*)`
   to `.claude/settings.local.json` — idempotently (append-if-absent, preserving the user's other
   permissions) and reversibly (uninstall strips only our entry, deleting the file if it was ours
   alone). Agents without a permission model get the guidance block only.

3. **`openlore connect` front-end (OneCommandAgentConnect).** A discoverable verb over the engine:
   - `openlore connect [agent]` — connect one agent, or (no agent + TTY) an interactive multi-select,
     pre-checked from detection; non-interactive falls back to detection (like bare `install`).
   - `openlore connect list` — every supported agent with a connection status.
   - `openlore connect remove [agent]` — disconnect (delegates to `--uninstall`).
   All paths delegate to `runInstall` / `surfaceStatus`; zero wiring logic is duplicated.

4. **Preset-insensitive status (`isConnected`).** Each adapter reports whether OpenLore's footprint is
   present (markdown block, or managed JSON entry) — a presence check, not config equality, so an
   agent wired with a different preset or an older template still reads as connected.

## What does NOT change

- **No duplicated engine.** No new registry, no second markdown-injector, no second JSON merger. The
  adapters, `block.ts` (sentinels + fingerprint hand-edit detection), and `json-managed.ts` are reused
  as-is. North star (`overview/spec.md`, decision `c6d1ad07`) preserved — this is local-first, offline,
  no-LLM plumbing.
- **No new MCP tool.** `connect` is a CLI verb; it adds nothing to any agent's tool context.
- **User files stay surgical.** Only the sentinel-delimited block / managed JSON keys are written;
  everything else is byte-preserved. `remove` strips only OpenLore's footprint.
- **`install` keeps working.** `connect` composes it; both share the same engine and flags.

## Research basis

The convergent onboarding pattern in the agent-tooling ecosystem: a single idempotent command, a
status view, capability-gated wiring, and curated tool surfaces — all of which OpenLore now exposes by
sharpening the engine it already had rather than re-implementing it. The deliberate scoping: this is
distribution plumbing only; it changes how the deterministic engine is reached, never what it computes.

## Application to OpenLore

- `--preset` reuses `TOOL_PRESETS` from `mcp.ts` (dynamic-imported only when a preset is passed, to
  keep the common path light) and the adapters' existing MCP-entry wiring.
- Permission wiring reuses `serializeManaged` / `editJsonPreservingFormat` (`json-managed.ts`) for
  format-preserving idempotent edits.
- `connect` reuses `runInstall`, `detect`, and a new `surfaceStatus` (which calls each adapter's
  `isConnected`). Interactive multi-select uses `@inquirer/prompts` `checkbox` (already a dependency).

## Out of scope

- **A pure data-only agent registry.** The existing adapter pattern (small per-agent modules sharing
  `markdown-block.ts` / `json-managed.ts`) already makes adding an agent a contained change; converting
  it to a pure declarative table is a larger refactor with no user-facing payoff and was not done.
- **Broadening the agent matrix** (windsurf, copilot, codex adapters beyond the current five). The
  `connect` UX and engine enhancements are agent-count-agnostic; new adapters are additive follow-ups.
- **Migrating config from other tools.** Low value for a code-anchored, per-repo tool; deferred.
- **A lean default preset.** `connect`/`install` default to the full surface until
  `add-lean-default-tool-surface` lands a curated default; then that name becomes the default here.
- **Listing the preset's tools inside the guidance block.** The guidance already references tool names;
  enumerating the exact active preset in-file was dropped as low-value churn.

## Implementation status

**Done (branch `feat/recall-deterministic-ranking`, PR #161).** All delivered requirements
(`OneCommandAgentConnect`, `IdempotentManagedSectionInjection`, `CapabilityGatedWiring`,
`PresetAwareConnect`, `ExtensibleAdapterRegistry`) are satisfied and guarded by tests.

What landed:

- **`src/cli/commands/connect.ts`** — the `connect` / `connect list` / `connect remove` command +
  `runConnect` (interactive multi-select via `@inquirer/prompts`, non-TTY detection fallback).
- **`src/cli/install/index.ts`** — `InstallOptions` gains `preset` + `agents[]`; preset validated
  against `TOOL_PRESETS`; new exported `surfaceStatus()` for the status view.
- **`src/cli/install/adapters/claude-code.ts`** — preset-aware MCP entry + `Bash(openlore:*)`
  permission wiring (apply + reversible uninstall) + `isConnected`.
- **`src/cli/install/adapters/cursor.ts`** — preset-aware MCP entry + `isConnected`.
- **`cline.ts` / `agents-md.ts` / `continue.ts`** — `isConnected`; **`markdown-block.ts`** — shared
  `hasManagedBlock` presence helper; **`types.ts`** — `ApplyContext.preset`, `Adapter.isConnected`.
- **`src/cli/index.ts`** — registers `connect`.

Verification:

- **Unit + e2e** `src/cli/commands/connect.test.ts` (10 tests): preset threading (incl. unknown-preset
  → exit 2, no files), permission idempotency / user-permission preservation / reversible uninstall,
  connect delegation to the engine, and preset-insensitive `surfaceStatus`.
- **No regressions** in the existing `src/cli/install` suite (47 tests).
- **Dogfood (built CLI on a temp repo):** `connect claude-code --preset memory` injects the CLAUDE.md
  block (preserving the user's existing content), writes `.mcp.json` with `--preset memory`, the
  SessionStart hook, and the permission; a re-run is fully idempotent (all noop); `connect list` reports
  `connected` (preset-insensitive); `connect remove` strips everything and leaves the user's content.
- **Full suite green:** `vitest run src` — 185 files, 3858 passed / 2 skipped / 0 failed. `typecheck`
  and `eslint` clean.
