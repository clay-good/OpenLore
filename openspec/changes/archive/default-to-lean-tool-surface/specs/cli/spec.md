# cli spec delta

## MODIFIED Requirements

### Requirement: ToolSurfaceSelection

The system SHALL expose a configurable MCP tool surface selected by `selectActiveTools`. When no
selector is given, the system SHALL expose a **lean default surface** — an evidence-backed,
navigation-first subset (the Spec 14 benchmark-winning surface), NOT the full registry. The full
`TOOL_DEFINITIONS` surface SHALL remain available via an explicit selector (`--preset full` or
`--all-tools`). The legacy `--minimal` selector and every named preset (`minimal`, `navigation`,
`memory`, `verify`, `federation`) SHALL retain their current membership and behavior. An unknown
preset name SHALL throw so a typo fails loudly rather than silently exposing the full surface.

#### Scenario: No selector exposes the lean default, not all tools

- **GIVEN** an MCP server started with no preset and no `--minimal`
- **WHEN** the active tool surface is resolved
- **THEN** it is the lean default surface (the benchmark-winning navigation-first subset), and is
  strictly smaller than `TOOL_DEFINITIONS`

#### Scenario: The full surface is available by explicit opt-in

- **GIVEN** an MCP server started with `--preset full` (or `--all-tools`)
- **WHEN** the active tool surface is resolved
- **THEN** it contains exactly `TOOL_DEFINITIONS` — the prior default behavior, restorable by one
  explicit selector

#### Scenario: Existing presets are unchanged

- **GIVEN** an MCP server started with `--preset navigation` (or `minimal` / `memory` / `verify` /
  `federation`)
- **WHEN** the active tool surface is resolved
- **THEN** its membership is identical to before this change

## ADDED Requirements

### Requirement: InstallWiresLeanDefaultSurface

`openlore install` (and `openlore connect`) SHALL wire the MCP server to the lean default surface when
the user passes no `--preset`, rather than to the full surface. `--preset full` and the other named
presets SHALL each wire exactly that surface. The change SHALL preserve the merge-not-clobber install
contract (decision `df27e8ef`): only OpenLore-managed paths are written, and re-runs are idempotent.

#### Scenario: Default install yields the benchmark-winning surface

- **GIVEN** a project and `openlore install` run with no `--preset`
- **WHEN** the registered MCP server entry is inspected
- **THEN** it is wired to the lean default surface, matching the configuration that wins the Spec 14
  benchmark

#### Scenario: Full surface restorable at install time

- **GIVEN** `openlore install --preset full`
- **WHEN** the registered MCP server entry is inspected
- **THEN** it is wired to the full `TOOL_DEFINITIONS` surface

### Requirement: BreadthDiscoverabilityOnLeanDefault

When the lean default surface is active, the system SHALL advertise — once, through the existing MCP
server instructions/server-info channel and without adding tool schemas — that additional tools are
available behind named presets, including how to opt in. This pointer SHALL NOT be emitted on the full
surface and SHALL NOT increase the number of tool schemas the agent must consider.

#### Scenario: An agent on the lean default learns breadth exists

- **GIVEN** an MCP session on the lean default surface
- **WHEN** the agent reads the server instructions/server-info
- **THEN** it finds a single pointer to the named presets and how to opt in, with no extra tool
  schemas added to the surface

### Requirement: DefaultAndFullToolCountsAreGuarded

The documentation count guards SHALL assert the documented "default surface" count against the lean
default preset and the documented "full surface" count against `TOOL_DEFINITIONS.length`, so neither
figure can drift silently as the registry changes.

#### Scenario: Count guard distinguishes default from full

- **GIVEN** the tool-count documentation guard
- **WHEN** it runs
- **THEN** it fails if the documented default count diverges from the lean default preset size or the
  documented full count diverges from `TOOL_DEFINITIONS.length`
