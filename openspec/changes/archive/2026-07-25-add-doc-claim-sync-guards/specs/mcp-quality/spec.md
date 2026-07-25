# mcp-quality spec delta

## ADDED Requirements

### Requirement: QuantitativeDocClaimsAreGuarded

Every quantitative claim published in a user-facing surface (README, `docs/`, `CLAUDE.md`,
`package.json` metadata, install templates) SHALL either be derived from code at render time (the
`${TOOL_DEFINITIONS.length}` pattern) or be bound to the code-derived value by a CI test that fails
when they diverge. Claims whose value is directly computable — the tool count, named preset sizes,
supported language and IaC ecosystem counts — SHALL be asserted equal to `TOOL_DEFINITIONS.length`,
the preset set sizes, and `CODE_LANGUAGES`/`IAC_LANGUAGES` respectively. A floor claim (e.g. a
minimum test count) that cannot be derived statically SHALL be pinned to a single canonical
constant adjacent to its guard, so changing the published figure requires touching the guard in the
same reviewed change. Guard failures SHALL name each stale file and location with the expected
value. Qualitative self-descriptions in package metadata SHALL NOT contradict the product's
recorded north star.

#### Scenario: A new tool is added without updating the docs

- **GIVEN** a change that grows `TOOL_DEFINITIONS` from 72 to 73 tools
- **WHEN** CI runs the doc-claim sync guard
- **THEN** the guard fails, listing every doc site still stating "72" with its file and location
- **AND** the change cannot merge until each listed site states the derived value

#### Scenario: A derived claim is verified, not trusted

- **GIVEN** a doc stating the substrate preset is "13 tools"
- **WHEN** the doc-claim sync guard runs
- **THEN** the stated size is asserted equal to the actual preset set's size, not to another
  hard-coded literal in the test

#### Scenario: A floor claim is pinned to its guard

- **GIVEN** the README states a minimum test count (e.g. "5500+ tests")
- **WHEN** the published floor is changed in any surface
- **THEN** the guard fails unless the canonical constant beside it is updated in the same change
- **AND** the floor is published as a floor, never restated as a measured exact figure

#### Scenario: Package metadata matches the recorded north star

- **GIVEN** the north-star decision positioning OpenLore as a structural context substrate for
  coding agents (`c6d1ad07`)
- **WHEN** `package.json` keywords or the `openspec.summary` describe the product
- **THEN** they describe the substrate positioning and do not restate the retired
  "reverse-engineer specs from code" product framing that contradicts the package `description`
