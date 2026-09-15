## Why

The Pi extension registers 45 tools, and all of them are active for the whole session. Each tool puts
its schema, a copy of its description (`promptSnippet`), and a guideline bullet into the system prompt.
The MCP default surface is the 15-tool `substrate` preset (ADR-0023). Pi has no lean default, so smaller
local models pay a larger standing-context cost and must choose from a flat list of 45 tools
(GitHub issue #505). The Pi host already supports runtime tool activation (`setActiveTools`), so a lean
default no longer requires removing tools.

## What Changes

- At session start the Pi extension SHALL activate only the lean surface: the tools of the MCP
  `substrate` preset plus `openlore_configure`. Every other OpenLore tool stays registered but inactive.
- Add one activator tool, `openlore_activate_tools`. It activates named, task-oriented tool groups
  (`specs`, `memory`, `review`, `quality`, `inspect`) for the rest of the session. Its description
  lists every group and the tools in it, so the agent can discover inactive tools.
- The groups are task groups, not the six capability families. The `navigate` family holds 57 tools
  and is too coarse to activate as one unit.
- Add the `.openlore/config.json` key `pi.toolSurface` (`"lean"` | `"all"`). `"all"` restores the
  current behavior (every tool active, no activator).
- Replace the duplicated `promptSnippet` (today it is the full tool description) with a short
  one-line snippet, and bound the Pi standing-context cost with a CI budget.
- The lean default ships with the change, for parity with the Claude Code default: `openlore install`
  wires `openlore mcp --preset substrate` (`LEAN_DEFAULT_PRESET`), and ADR-0023 benchmarked that
  surface. Pi adopts the same set; it does not introduce a new default surface.
- Record a decision that reverses the current source position that presets are an MCP-only concept
  that Pi does not use.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-quality`: the Pi parity guard defines "present in the Pi surface" as registered (active or
  activatable). New requirements cover the Pi lean default surface, group activation, the
  `pi.toolSurface` escape, and a standing-context budget for the Pi surface.

## Impact

- `src/pi/extension.ts`: group table, `session_start` activation, activator tool, short snippets.
- `src/pi/extension.test.ts`: group-coverage guard, activation behavior, budget guard; the existing
  parity guard stays unchanged in intent.
- `src/types/index.ts`: `pi.toolSurface` config type.
- Pi user documentation and the Pi install notes.
- No new benchmark: the MCP default preset does not change, so `bench/PROTOCOL.md` does not apply.
  The Pi lean set is derived from that preset.
- No daemon change: the daemon keeps `--preset full` and dispatches any known tool.
- Host behavior: activating a group changes the tool list and the system prompt, so the provider
  prompt cache misses once for each activation.
