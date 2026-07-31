# mcp-quality spec delta

## ADDED Requirements

### Requirement: PiSurfaceParityIsGuarded

The Pi extension's native tool surface SHALL be held in verified parity with the MCP tool surface
in both directions: every Pi-surfaced tool SHALL be dispatchable by the daemon (the existing
direction), AND every dispatchable conclusion tool SHALL either be present in the Pi surface or
appear on a named, source-commented exclusion list stating why its omission is deliberate. A CI
test SHALL fail when a conclusion tool is neither surfaced nor excluded, so a new MCP tool cannot
silently drift out of Pi — the same fails-until-you-decide discipline the tool-contract
classification test already enforces. Where a tool's input contract differs between surfaces
(e.g. an enum of claim kinds), the Pi declaration SHALL NOT silently omit capabilities the MCP
handler supports; a deliberate narrowing SHALL be stated in source.

#### Scenario: A new conclusion tool cannot skip the Pi decision

- **GIVEN** a new MCP tool classified `conclusion` in `TOOL_OUTPUT_CLASS`
- **WHEN** it is added without a Pi surface entry and without an exclusion-list entry
- **THEN** the parity guard test fails, naming the tool
- **AND** the failure is resolved only by surfacing it in Pi or adding it to the exclusion list
  with a stated reason

#### Scenario: A deliberate omission is recorded, not silent

- **GIVEN** a conclusion tool that belongs only to an opt-in preset surface (e.g. federation)
- **WHEN** it is placed on the Pi exclusion list with its reason
- **THEN** the parity guard passes and the omission is auditable in source

#### Scenario: Pi's verify_claim expresses every claim kind the handler supports

- **GIVEN** the MCP `verify_claim` handler supporting the `decision-current` claim kind
- **WHEN** a Pi agent is about to cite a decision id to a human
- **THEN** the Pi `verify_claim` tool accepts kind `decision-current` and returns the daemon's
  verdict (including `refuted` with the live superseder for a superseded decision), instead of the
  kind being inexpressible on the Pi surface
