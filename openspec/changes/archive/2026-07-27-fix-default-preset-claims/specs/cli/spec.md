# cli spec delta

## ADDED Requirements

### Requirement: DefaultPresetHasOneSource

The active default MCP tool preset SHALL be defined by exactly one source-of-truth constant
(`LEAN_DEFAULT_PRESET`), and every entry point that resolves a preset when none is given — the MCP
stdio server, the HTTP daemon (`serve`), `install` and its agent adapters, and `connect` — SHALL
resolve through that constant rather than a preset-name literal. User-facing help text that names
the default preset SHALL derive the name from the constant (never a hardcoded string), and a guard
test SHALL fail if any entry point reintroduces a literal fallback default or if help text names a
default other than the constant's value.

#### Scenario: All entry points serve the same default surface

- **GIVEN** no `--preset` selector on any entry point
- **WHEN** `openlore mcp`, `openlore serve`, and an `openlore install`-wired agent each start
- **THEN** all three expose the preset named by `LEAN_DEFAULT_PRESET`, with identical tool lists

#### Scenario: Help text cannot drift from the active default

- **GIVEN** a future benchmark-gated default flip that changes `LEAN_DEFAULT_PRESET`
- **WHEN** the constant changes and no help string is manually edited
- **THEN** `--help` output for `mcp`, `install`, and `connect` names the new default automatically
- **AND** the guard test fails if any entry point still resolves a hardcoded preset literal
