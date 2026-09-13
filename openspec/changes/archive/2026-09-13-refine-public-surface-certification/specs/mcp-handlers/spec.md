# mcp-handlers spec delta

## ADDED Requirements

### Requirement: PublicSurfaceRuleCodesAndSuggestedBump

Every classified change produced by `certify_public_surface` in diff mode SHALL carry stable rule
codes from a closed, documented set (`export-removed`, `export-renamed`, `export-visibility-reduced`,
`export-added`, `param-removed`, `param-required-added`, `param-became-required`,
`param-type-narrowed`, `return-type-narrowed`, `signature-unprovable`), in addition to its
human-readable reasons. The breaking-classed rule codes SHALL be registered in
`FINDING_CODE_REGISTRY` with source `public-surface` and default class `advisory`, and the diff
verdict SHALL include one governance finding per breaking-classed rule code per changed export, so
an `enforcement.policy` can gate an individual rule. The verdict SHALL include a computed
`suggestedBump` — `major` when any change is `breaking`, else `minor` when any export was added,
else `patch` — as a total function of the classification, with no tuning constant. The
`potentially-breaking` class SHALL keep its meaning: its rule code `signature-unprovable` SHALL NOT
be a breaking-classed code and SHALL NOT produce a finding. The consumer disclosure SHALL state that
only in-repo consumers were checked and SHALL NOT claim that sibling repositories are checked.

#### Scenario: A removed export carries its rule code and a finding

- **GIVEN** a diff that removes an exported symbol
- **WHEN** `certify_public_surface` classifies the diff
- **THEN** the change carries rule code `export-removed` alongside its reason
- **AND** the verdict's findings include an `export-removed` finding for that symbol

#### Scenario: Per-rule gating

- **GIVEN** an `enforcement.policy` mapping `export-removed` to `blocking` and nothing else
- **WHEN** a diff both removes an export and narrows a parameter type
- **THEN** only the `export-removed` finding resolves to blocking; `param-type-narrowed` stays
  advisory

#### Scenario: Suggested bump is computed, not guessed

- **GIVEN** a diff whose only surface change is a newly added export
- **WHEN** the verdict is assembled
- **THEN** `suggestedBump` is `minor`, a diff with any breaking change yields `major`, and a diff
  with only `potentially-breaking` changes yields `patch` with no finding
