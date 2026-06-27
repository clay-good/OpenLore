# Tasks — Default to a lean tool surface

> Status: IMPLEMENTED (2026-06-22). Membership decision recorded as `5a27b55d` (lean default =
> `navigation` verbatim; full opt-in via `--preset full` / `--all-tools`). No new MCP tool;
> `tool-contract.ts` unaffected.
>
> Note on §3: only the `claude-code` and `cursor` adapters wire an MCP server entry (`.mcp.json` /
> `.cursor/mcp.json`); `cline`, `continue`, and `agents-md` are markdown/instruction-only and register
> no MCP server, so they needed no change. `connect` delegates to `runInstall`, so it inherits the
> wiring automatically. `docs/install.md` carries no tool-count phrasing, so the migration note landed
> in README, `docs/mcp-tools.md`, and CLAUDE.md.

## 1. Define the lean default surface
- [x] Record the default-surface membership decision (lean, navigation-first, evidence-backed) and the
      full-surface selector name (`full`). Reference the Spec 14 benchmark result as the rationale.
- [x] Add the chosen default as a named entry alongside the existing `TOOL_PRESETS`
      (`src/cli/commands/mcp.ts`), reusing `navigation` membership unless the decision widens it.
- [x] Add a `full` preset (or `--all-tools` flag) that maps to `TOOL_DEFINITIONS` so the prior
      behavior is restorable by one explicit selector.

## 2. Invert the default in selectActiveTools
- [x] Change `selectActiveTools(allTools, {})` (no selector) to return the lean default surface, not
      `allTools`. `--preset full` / `--all-tools` returns `allTools`. Unknown preset still throws.
- [x] Keep `--preset <name>` and the legacy `--minimal` behavior exactly as today for every existing
      preset.
- [x] Test: no selector → lean default membership; `--preset full` → `TOOL_DEFINITIONS.length`;
      `--minimal` and every named preset unchanged; unknown preset throws.

## 3. Install wires the lean default
- [x] `mcpEntry` (claude-code adapter) and peer adapters wire the lean default preset name when the
      user passes no `--preset`, instead of `undefined` (full surface).
      → `src/cli/install/adapters/claude-code.ts`, `cursor.ts`, `cline.ts`, `continue.ts`,
      `agents-md.ts`; `src/cli/install/index.ts`, `src/cli/commands/connect.ts`.
- [x] `openlore install --preset full` (and the other named presets) still wire exactly that surface.
- [x] Test: default install writes `mcp ... --preset <lean-default>` to `.mcp.json`; `--preset full`
      writes the full-surface selector; uninstall is coherent for both.

## 4. Breadth discoverability
- [x] On the lean default surface, advertise once (via the existing MCP server instructions/server-info
      channel, not via extra tool schemas) that more tools are available behind named presets, naming
      how to opt in.
- [x] Test: the lean default surface includes the breadth pointer; the full surface does not duplicate
      it; the pointer adds no tool schemas.

## 5. Count guards + migration note
- [x] Extend `mcp-tool-count-doc.test.ts` and `mcp-presets.test.ts` so the documented "default" count
      is asserted against the lean default preset and the "full" count against `TOOL_DEFINITIONS.length`
      — preventing the silent doc/count drift recorded in `project_mcp_tool_doc_count_drift`.
- [x] Update README, `docs/mcp-tools.md`, `docs/install.md`, and CLAUDE.md so any "N tools by default"
      phrasing reflects the lean default, with a one-line "restore the full surface with `--preset full`"
      migration note.

## 6. Docs
- [x] Document the default-vs-full distinction, the rationale (Spec 14 benchmark), and the opt-in
      escape hatch in the `cli` and `mcp-quality` specs and the docs above.
