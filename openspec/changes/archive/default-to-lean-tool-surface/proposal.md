# Default to a lean tool surface: make the benchmark-winning preset the default, breadth opt-in

> Status: IMPLEMENTED (2026-06-22). Second of three changes that close the loss case in OpenLore's own
> agent benchmark (siblings: `add-task-scoped-context-injection`, `add-prove-shareable-scorecard`).
> Touches `selectActiveTools` / `mcpEntry` (`src/cli/commands/mcp.ts`, `src/cli/install/adapters/*`).
> Inverts a default; adds no new tool. Realizes the long-agreed direction to slim the default surface
> (decision `b16e094b`, Lean default tool surface); concrete membership recorded as decision `5a27b55d`.
>
> **Implementation note (2026-06-22).** Shipped on branch `feat/default-lean-tool-surface`. The lean
> default = the `navigation` preset verbatim (10 tools); the full 62-tool surface is opt-in via
> `--preset full` / `--all-tools`. `openlore install`/`connect` now wire `--preset navigation` by
> default. A breadth pointer is emitted once via the MCP `initialize` `instructions` channel whenever
> the active surface IS the lean default (no tool schemas added).
>
> **Adversarial-review hardening (decision `5fdc9da7`).** A multi-agent adversarial e2e pass found and
> fixed four contract gaps after the initial implementation: (1) the breadth pointer was gated on "no
> selector at all," so `openlore install` — which wires `--preset navigation` explicitly — suppressed
> the very pointer this change added; both the tool selection and the pointer decision now resolve
> through one `resolvePresetName()` helper, and the pointer fires whenever the resolved surface IS the
> lean default (navigation), however it was reached, while every other deliberately-chosen surface
> suppresses it. (2) `openlore mcp --preset <bad>` threw an uncaught stack trace (exit 1); it now exits
> 2 with a clean message, mirroring install. (3) the `cursor` install adapter froze the wired preset on
> re-install (an early-return on an unchanged `.mdc` skipped MCP registration), so preset switching was
> silently ignored on Cursor — now fixed. (4) selector parity: `serve` accepts `full` as an alias of
> `all`; `install`/`connect` accept `--all-tools`; and the `all` alias normalizes to canonical `full` in
> the wired arg. Verified end-to-end on the live server and via real install/connect/serve lifecycles
> (default → 10 tools + pointer; explicit `--preset navigation` → 10 + pointer; `--minimal`/`memory` →
> no pointer; `--preset full`/`--all-tools` → 62, no pointer; cursor default↔full switching tracks).
>
> **Second adversarial round (2026-06-22) — completeness + robustness.** A follow-up multi-agent pass
> closed the remaining gaps: (a) added the `CHANGELOG.md` `[Unreleased]` entry for the behavior change
> with the governance migration note; (b) reconciled the **live** `mcp-quality` spec — its
> `Tool Surface Size and Progressive Disclosure` requirement still said the lean default SHOULD be
> minimal and that navigation tools belonged in an opt-in preset "not the lean default," directly
> contradicting what shipped; it now states the lean default IS the `navigation` preset (SHALL) and
> fixes a stale `~45 tools` count to 62; (c) hardened `openlore install` against a hostile `.mcp.json`
> whose `mcpServers` is a non-object value (string/number/null/array), which previously crashed the
> format-preserving JSON editor mid-install — it now falls back to a clean merged write. A real
> end-to-end tool CALL (`orient`, `search_code`, `get_subgraph`) through an install-wired lean server
> was confirmed functional, and uninstall/multi-agent/malformed-config lifecycles were verified.
>
> **Explicitly reverses a prior sub-decision.** Decision `d54af0d3` (Spec 28, "Lean MCP tool surface
> via lossless trim…") recorded that *"forcing the navigation preset as install default was rejected
> (hides governance tools the decision gate needs, per Spec 25 Phase B)."* This change reverses that
> narrow sub-clause — the rest of `d54af0d3` (lossless trim + payload-size guard) still holds, so it is
> NOT superseded. The original concern is mitigated: governance stays one opt-in away (`--minimal` /
> `--preset full`), the breadth pointer advertises that opt-in, and CLAUDE.md + the migration note tell
> repos that gate commits to install `--preset full`.

## Why

OpenLore exposes **62 MCP tools**. Two facts in the repo are in tension:

1. **The default surface is "all tools."** `selectActiveTools(TOOL_DEFINITIONS, {})` returns the full
   set, and `openlore install` wires the MCP server with **no preset** unless one is passed
   explicitly (`mcpEntry(ctx.preset)` with `ctx.preset` usually undefined). So the out-of-box
   experience hands every agent all 62 tool schemas.

2. **The benchmark winner is a ~10-tool surface.** The Spec 14 agent benchmark and decision
   `8…`/Spec 14 record that OpenLore wins its target arena specifically *with* `--preset navigation`,
   and the `mcp-quality` spec already requires minimizing the number of tools an agent must consider
   (schemas for tools the agent never calls are "pure overhead").

The default contradicts the measured result and the project's own quality rule. Every agent that
installs OpenLore the documented way pays for 62 schemas when the configuration that wins pays for
~10. This is per-session token overhead *and* a correctness/latency tax: a larger surface raises the
chance the agent selects a wrong or redundant tool, and the scorecard's small/familiar regression is
worsened (not caused) by carrying schemas the task never needed.

The honest, low-risk fix is to invert the default: ship the lean, benchmark-winning surface as what
`openlore install` wires by default, and make the full set an explicit opt-in (`--preset full` or
`--all-tools`). Nothing is removed — every tool stays reachable; the *default* simply becomes the
surface the evidence supports. This is the cheapest, already-half-decided lever among the three loss-
case changes.

## What changes

1. **A named default surface.** Define the surface `openlore install` wires when no preset is given.
   It is a lean, navigation-first set — the benchmark-winning `navigation` preset, optionally widened
   by the small `minimal` governance core where a task class needs it — codified as the default
   rather than left as "all tools." The exact membership is recorded in a decision before
   implementation; the requirement is that the default is lean and evidence-backed, not the full
   registry.

2. **Opt-in breadth.** The full 62-tool surface remains available via an explicit selector
   (`openlore mcp --preset full` / an `--all-tools` flag, and `openlore install --preset full`).
   Every existing preset (`minimal`, `navigation`, `memory`, `verify`, `federation`) is unchanged and
   still selectable. No capability is removed; only the default changes.

3. **Install wires the lean default.** `mcpEntry` / the install adapters wire the lean default preset
   into `.mcp.json` (and each adapter's MCP registration) when the user passes no `--preset`, so the
   documented one-command install yields the benchmark-winning surface out of the box.

4. **Discoverability of breadth.** When an agent is on the lean default, the surface advertises — once,
   cheaply — that more tools exist behind a named preset, so an agent that needs governance/federation
   /memory tools knows the opt-in exists rather than concluding the capability is absent. (A single
   pointer, not 50 re-advertised schemas.)

5. **Guarded counts and a migration note.** The existing tool-count documentation guard
   (`mcp-tool-count-doc.test.ts`) and preset tests are extended so the "default surface" count is
   asserted against the lean preset, the "full surface" count stays asserted against
   `TOOL_DEFINITIONS.length`, and a one-line migration note tells existing users how to restore the
   full surface if they relied on it.

## What does NOT change

- **No tool is removed.** All 62 tools remain implemented, registered, and reachable; only the default
  selection changes. `--preset full` restores the prior behavior exactly.
- **No new MCP tool.** This is a default-selection change in `selectActiveTools` / install wiring.
- **Every existing preset is unchanged.** `minimal`, `navigation`, `memory`, `verify`, `federation`
  keep their current membership and selectors.
- **The contract guards hold.** Per-tool input validation, timeouts, output-size caps, annotations,
  and `tool-contract.ts` classification are untouched; this changes which tools are *exposed*, not how
  any tool behaves.
- **No LLM.** Default selection is static configuration. The north star (`c6d1ad07`) holds.

## Research basis

The MCP best-practice that schemas for unused tools are pure per-request overhead (the basis of the
project's own `mcp-quality` minimize-tool-surface requirement); the tool-confusion / tool-overload
findings that agent tool-selection accuracy degrades as the candidate set grows; and OpenLore's own
Spec 14 measurement that the navigation-sized surface — not the full registry — is what produces the
net win in its target arena. The change is simply aligning the default with the project's already-
published evidence and rule, rather than introducing a new idea.

## Application to OpenLore

- **Default selection** is implemented in `selectActiveTools` (`src/cli/commands/mcp.ts`) by defining
  the no-selector return as the lean default preset rather than `allTools`, with `full` as the
  explicit escape hatch.
- **Install wiring** reuses `mcpEntry(preset)` (`src/cli/install/adapters/claude-code.ts` and the
  peer adapters): the default install passes the lean preset name instead of `undefined`.
- **Count guards** reuse `mcp-tool-count-doc.test.ts` and `mcp-presets.test.ts`, extended to assert
  the default-vs-full distinction (preventing silent drift, the same failure mode
  `project_mcp_tool_doc_count_drift` recorded).
- **Discoverability** reuses the existing server-info / instructions channel rather than adding tools.

## Relationship to the sibling changes

This removes the per-session tool-schema *bytes*. `add-task-scoped-context-injection` removes the per-
task orient *round-trip*. `add-prove-shareable-scorecard` lets a user *measure* the combined effect.
Independently shippable; this is the lowest-effort, lowest-risk of the three.

## Out of scope

- **Redesigning preset membership.** Beyond naming and wiring the lean default, re-curating which
  tools live in which preset is separate work; this change picks an evidence-backed default from
  existing presets, not a new taxonomy.
- **Removing or deprecating any tool.** Pruning the registry (the Tier-4 "quarantine speculative
  subsystems" idea) is a distinct, larger change and is explicitly not bundled here.
- **Dynamic/per-task tool selection.** Choosing tools per task at runtime is out of scope; this sets a
  static default with an opt-in escape hatch.
- **Changing MCP transport or the tools/list byte-trimming** already covered by Spec 28.
