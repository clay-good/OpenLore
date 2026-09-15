## Context

See proposal.md — Why. Current state in `src/pi/extension.ts`:

- At load, the extension registers 42 `NAV_TOOLS`, `openlore_prepare_spec_generation`,
  `openlore_prepare_spec_repair`, and `openlore_configure`. Pi activates each newly registered
  extension tool by default.
- Each `NAV_TOOLS` entry sets `promptSnippet: tool.description`, so Pi's "Available tools" section
  repeats every full description.
- The file header states that presets and families are MCP-wire concepts that Pi does not use.
  This change reverses that statement.
- Pi host API (`@earendil-works/pi-coding-agent` ^0.84): `getActiveTools()`, `getAllTools()`,
  `setActiveTools(names)`. `setActiveTools` replaces the full active set and rebuilds the system
  prompt; the change applies from the next model request. `promptGuidelines` of inactive tools are
  left out of the prompt.
- The daemon runs `--preset full` and dispatches every tool. It needs no change.
- `pi.spawnDaemon` is read directly from `.openlore/config.json` (`piMaySpawnDaemon`), without
  `readConfig`, so it works before a provider is configured.

## Goals / Non-Goals

**Goals:**
- Lean standing context by default, with every current tool still reachable in one call.
- Keep the parity guard and the daemon contract unchanged in intent.
- Keep one config switch that restores today's behavior exactly.

**Non-Goals:**
- Deactivating groups during a session.
- Changing the MCP presets, the capability families, or the daemon.
- Automatic activation from task text or from tool results.
- Persisting activation across sessions.

## Decisions

### D1. Register everything at load, activate a subset at `session_start`

Keep all registrations at load. In `session_start`, read `pi.toolSurface`, snapshot
`pi.getActiveTools()`, and call `setActiveTools` with the snapshot minus the non-lean OpenLore tools.

- Why: the parity guard, `getAllTools()`, and the daemon health check (`missingDaemonTools`) stay
  unchanged; activation is a single host call.
- Alternative: register group tools lazily from the activator. Rejected — config is per-`cwd` and
  unknown at load, registration order would depend on the session, and the parity guard would need
  a second code path.

### D2. Task groups, not capability families

The `navigate` family holds 57 tools, and the substrate preset spans four families, so families do
not produce useful activation units. Group table (a new exported constant, next to `NAV_TOOLS`):

| Group | Tools |
|-------|-------|
| lean (always active) | `orient`, `search_code`, `get_subgraph`, `trace_execution_path`, `find_path`, `analyze_impact`, `suggest_insertion_points`, `get_function_skeleton`, `get_map`, `get_landmarks`, `recall`, `verify_claim`, `blast_radius`, `prepare_spec_generation`, `prepare_spec_repair`, `configure`, `activate_tools` |
| `specs` | `search_specs`, `get_spec`, `list_spec_domains`, `search_unified`, `check_spec_drift`, `audit_spec_coverage` |
| `memory` | `remember`, `record_decision`, `list_decisions`, `approve_decision`, `reject_decision`, `sync_decisions` |
| `review` | `structural_diff`, `select_tests`, `get_test_coverage`, `briefing_since`, `certify_public_surface` |
| `quality` | `get_refactor_report`, `get_health_map`, `get_critical_hubs`, `get_god_functions`, `get_architecture_overview`, `get_surprising_connections`, `find_clones`, `get_style_fingerprint` |
| `inspect` | `get_function_body`, `get_file_dependencies`, `analyze_error_propagation`, `analyze_env_impact` |

The lean row is the MCP `SUBSTRATE` set plus the two Pi-only utility tools. A test derives the
expected lean set from the MCP preset definition, so the two surfaces cannot drift (spec:
PiDefaultToolSurfaceIsLean).

- Alternative: one group per family. Rejected — see above.
- Alternative: many small groups. Rejected — more names for a small model to choose from, and more
  activations, so more prompt-cache misses.

### D3. Activator contract

`openlore_activate_tools({ names: string[] })`. Each name resolves to a group name or to the group of
a tool name (the `openlore_` prefix is optional). The handler computes the union of the group tools,
removes the tools in the host-excluded set, and calls `setActiveTools(current ∪ added)`. It returns
the activated tools, the groups that were already active, and the host-excluded tools. An unknown
name returns an error that lists the groups and activates nothing (all-or-nothing validation).

The description lists each group with its tool names, one line per group. Its guideline tells the
agent to call the activator before it uses a tool from a group, and when an OpenLore result names a
tool that is not available.

- Why tool names are accepted: `orient` output and the injected architecture digest name tools such
  as `check_spec_drift`. A small model can copy that name directly.

### D4. Host exclusion snapshot

The host `--tools` allowlist filters the initial active set, but `setActiveTools` does not check the
allowlist. At `session_start`, before the lean surface is applied, the extension records the OpenLore
tools that are **not** active. Those tools form the host-excluded set, and the activator never adds
them. In `"all"` mode the extension does not call `setActiveTools` for OpenLore tools, except to
deactivate the activator.

### D5. `pi.toolSurface` read like `pi.spawnDaemon`

Add `toolSurface?: 'lean' | 'all'` to the Pi config type. Read it with a direct JSON read of
`.openlore/config.json` (the `piMaySpawnDaemon` pattern), because `readConfig` returns null until a
provider is configured. Any value other than the exact string `"all"` selects lean. No environment
variable: YAGNI; add one only if a host needs a per-process override.

### D6. Short snippets and a budget

Add a `PI_TOOL_SNIPPETS` map next to `NAV_TOOLS` (one line, at most 90 characters, trigger-first
like the current descriptions); a test requires one entry per `NAV_TOOLS` tool and no stale entry.
A map keeps the 42 entries in one reviewable block instead of 42 scattered field edits. The budget
estimator uses the pattern of `STANDING_CONTEXT_BUDGETS`: characters of the description, JSON
schema, snippet, and guidelines, divided by 4, summed over the registered tools of each surface. It
records the measured baseline with about 7% headroom for the `lean` and `all` surfaces.

### D7. Lean default from the first merge, by parity

The default is `"lean"` when the change ships. The Claude Code install wires
`openlore mcp --preset substrate` (`LEAN_DEFAULT_PRESET`, ADR-0023). Pi uses the same tool set, so Pi
does not choose a new default; it follows the MCP default. The test in D2 keeps the two sets equal.
If `LEAN_DEFAULT_PRESET` changes later, the Pi lean set changes with it.

Claude Code also loads MCP tool schemas on demand, so its standing cost is lower than the preset
alone suggests. The Pi host has no deferral; the activator gives Pi the same effect.

- Alternative: a separate small-model Pi benchmark before the flip. Rejected — `bench/PROTOCOL.md`
  gates changes to the MCP default preset, and this change does not modify that preset. A Pi runner
  arm would add a large harness change for a surface that is already cleared. `pi.toolSurface: "all"`
  remains the escape if a host model does not use the activator.

## Risks / Trade-offs

- [Prompt-cache miss on each activation] → Few, coarse groups; activation is additive, with no
  deactivate cycle.
- [Agent does not know that an inactive tool exists] → Activator description lists all tools; tool
  names are accepted; guideline covers "named tool not available".
- [Small model never calls the activator, so it loses capability] → The lean set is the benchmarked
  MCP default; the `"all"` escape stays and is documented.
- [Pi API behavior changes (default activation, allowlist handling)] → Tests use the mocked
  `ExtensionAPI` for the contract; the existing real-loader CI job checks that the extension loads.
- [Group membership is a judgment call] → The coverage test forces a decision for each new tool;
  membership can change without a spec change.

## Migration Plan

1. Merge with the default `"lean"`. Release notes name the change and the `pi.toolSurface: "all"`
   escape.
2. Rollback: set `pi.toolSurface: "all"` in the project, or revert the commit.

## Open Questions

- Final group names and membership may change after use in real sessions. This needs no spec change,
  because the spec does not name the groups.
