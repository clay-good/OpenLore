## MODIFIED Requirements

### Requirement: PiSurfaceParityIsGuarded

The Pi extension's native tool surface SHALL be held in verified parity with the MCP tool surface
in both directions: every Pi-surfaced tool SHALL be dispatchable by the daemon (the existing
direction), AND every dispatchable conclusion tool SHALL either be present in the Pi surface or
appear on a named, source-commented exclusion list stating why its omission is deliberate. A tool
is present in the Pi surface when the extension registers it, whether the tool is active at session
start or becomes active through a tool group. A CI test SHALL fail when a conclusion tool is neither
surfaced nor excluded, so a new MCP tool cannot silently drift out of Pi — the same
fails-until-you-decide discipline the tool-contract classification test already enforces. Where a
tool's input contract differs between surfaces (e.g. an enum of claim kinds), the Pi declaration
SHALL NOT silently omit capabilities the MCP handler supports; a deliberate narrowing SHALL be
stated in source.

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

#### Scenario: A registered but inactive tool counts as surfaced

- **GIVEN** a conclusion tool that the Pi extension registers inside a tool group
- **WHEN** the tool is inactive at session start
- **THEN** the parity guard treats the tool as present in the Pi surface
- **AND** the guard does not require an exclusion-list entry for it

## ADDED Requirements

### Requirement: PiDefaultToolSurfaceIsLean

When a Pi session starts with the default configuration, the Pi extension SHALL activate only its
lean surface: the Pi tools that correspond to the MCP `substrate` preset, the configuration tool,
and the tool-group activator. All other OpenLore tools SHALL stay registered and inactive. The
extension SHALL NOT change the active state of any tool that OpenLore does not register. The lean
surface SHALL apply in every Pi session mode.

#### Scenario: Default session exposes only the lean surface

- **GIVEN** a repository whose `.openlore/config.json` has no `pi.toolSurface` key
- **WHEN** a Pi session starts
- **THEN** the active OpenLore tools are exactly the Pi tools of the `substrate` preset, the
  configuration tool, and the activator
- **AND** every other OpenLore tool is registered but inactive

#### Scenario: Host tools are not changed

- **GIVEN** a Pi session in which the host has activated built-in and other extension tools
- **WHEN** the OpenLore extension applies its lean surface
- **THEN** the active state of every non-OpenLore tool is unchanged

#### Scenario: Substrate preset and Pi lean surface stay aligned

- **GIVEN** a change that adds a tool to, or removes a tool from, the MCP `substrate` preset
- **WHEN** the Pi lean surface does not match the Pi-registered tools of that preset
- **THEN** a CI test fails, naming the tools that differ

### Requirement: PiToolGroupsAreActivatable

Every OpenLore tool that the Pi extension registers outside the lean surface SHALL belong to exactly
one named tool group. The activator SHALL accept a list of names. Each name SHALL be a group name, or
the name of a tool (with or without the `openlore_` prefix), which activates the group that contains
it. The activator description SHALL list every group with the names of its tools. Activation SHALL be
additive and idempotent, and SHALL last until the session ends; a new session SHALL start with the
lean surface. The activator SHALL NOT activate a tool that was inactive when the session started for a
reason other than the lean surface (for example, a host tool allowlist).

#### Scenario: Every non-lean tool has one group

- **GIVEN** the set of tools the Pi extension registers
- **WHEN** the group-coverage test runs
- **THEN** it fails if a tool outside the lean surface belongs to no group or to more than one group

#### Scenario: Activating a group

- **GIVEN** a default Pi session
- **WHEN** the agent calls the activator with one valid group name
- **THEN** every tool in that group becomes active from the next model request
- **AND** the result names the tools that were activated

#### Scenario: Activating by tool name

- **GIVEN** a default Pi session in which a tool is inactive
- **WHEN** the agent calls the activator with that tool's name
- **THEN** the group that contains the tool becomes active

#### Scenario: Repeated activation changes nothing

- **GIVEN** a group that is already active
- **WHEN** the agent activates the same group again
- **THEN** the set of active tools does not change
- **AND** the result says that the group was already active

#### Scenario: Unknown name

- **WHEN** the agent calls the activator with a name that is neither a group nor a registered tool
- **THEN** no tool is activated
- **AND** the result is an error that lists the valid group names

#### Scenario: Host exclusion is respected

- **GIVEN** a Pi session in which the host allowlist excludes an OpenLore tool
- **WHEN** the agent activates the group that contains that tool
- **THEN** the excluded tool stays inactive
- **AND** the result names the tool as excluded by the host

### Requirement: PiToolSurfaceHasAnEscape

The `.openlore/config.json` key `pi.toolSurface` SHALL select the Pi tool surface. The value `"all"`
SHALL activate every OpenLore tool at session start and SHALL leave the activator inactive. The value
`"lean"`, an absent key, a malformed value, or an unreadable configuration SHALL select the default
lean surface. The key SHALL be read without requiring an LLM provider to be configured.

#### Scenario: Operator keeps every tool active

- **GIVEN** `.openlore/config.json` contains `"pi": { "toolSurface": "all" }`
- **WHEN** a Pi session starts
- **THEN** every OpenLore tool is active
- **AND** the activator is inactive

#### Scenario: Malformed value falls back to lean

- **GIVEN** `.openlore/config.json` contains `"pi": { "toolSurface": 3 }`
- **WHEN** a Pi session starts
- **THEN** the lean surface is active and the session starts without error

#### Scenario: No provider configured

- **GIVEN** a configuration with `pi.toolSurface` set to `"all"` and no LLM provider
- **WHEN** a Pi session starts
- **THEN** every OpenLore tool is active

### Requirement: PiStandingContextIsBudgeted

A CI test SHALL compute a deterministic estimate of the standing context that the OpenLore tools add
to the Pi prompt, for the lean surface and for the `"all"` surface. The estimate SHALL include each
active tool's parameter schema, prompt snippet, and guideline. Each surface SHALL have a reviewed
budget that records its measured baseline and its headroom; the test SHALL fail when an estimate
exceeds its budget. Each tool's prompt snippet SHALL be one line and SHALL NOT be identical to the
tool's full description.

#### Scenario: Surface grows past its budget

- **GIVEN** a change that adds tools or text to the Pi lean surface
- **WHEN** the lean estimate exceeds the lean budget
- **THEN** the budget test fails, naming the surface, the estimate, and the budget

#### Scenario: Snippet duplicates the description

- **WHEN** a Pi tool's prompt snippet equals its full description or contains a line break
- **THEN** the snippet test fails, naming the tool
