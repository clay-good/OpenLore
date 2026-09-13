# mcp-handlers spec delta

## ADDED Requirements

### Requirement: PublicSurfaceRuleCodesAndSuggestedBump

Every breaking or potentially-breaking change, and every added export, produced by
`certify_public_surface` in diff mode SHALL carry stable rule codes from a closed, documented set
(`export-removed`, `export-renamed`, `export-visibility-reduced`, `export-added`, `param-removed`,
`param-required-added`, `param-became-required`, `param-type-narrowed`, `return-type-narrowed`,
`signature-unprovable`), in addition to its human-readable reasons; a non-breaking change with no
contract effect carries none. The eight breaking-classed codes and `signature-unprovable` SHALL be
registered in `FINDING_CODE_REGISTRY` with source `public-surface` and default class `advisory`,
and the diff verdict SHALL include one governance finding per such code per changed export —
severity `error` for a breaking-classed code and `warning` for `signature-unprovable` — so the
caller that runs the tool can gate an individual rule with an `enforcement.policy`. The
`potentially-breaking` class SHALL keep its meaning: `signature-unprovable` SHALL NOT be a
breaking-classed code. The verdict SHALL include a `suggestedBump`: `major` when any change is
`breaking`; otherwise withheld (`null`, with a reason) when any change is `potentially-breaking` or
the changed files are in no signature-classifiable language; otherwise `minor` when an export was
added, else `patch`. The consumer disclosure SHALL state that only in-repo consumers were checked
and SHALL NOT claim that sibling repositories are checked.

#### Scenario: A removed export carries its rule code and a finding

- **GIVEN** a diff that removes an exported symbol
- **WHEN** `certify_public_surface` classifies the diff
- **THEN** the change carries rule code `export-removed` alongside its reason
- **AND** the verdict's findings include an `export-removed` finding of severity `error`

#### Scenario: Per-rule gating

- **GIVEN** an `enforcement.policy` mapping `export-removed` to `blocking` and nothing else
- **WHEN** a diff both removes an export and narrows a parameter type
- **THEN** only the `export-removed` finding resolves to blocking; `param-type-narrowed` stays
  advisory

#### Scenario: Suggested bump is never unproven-safe

- **GIVEN** a diff whose only surface change is a newly added export
- **WHEN** the verdict is assembled
- **THEN** `suggestedBump` is `minor`, and a diff with any breaking change yields `major`
- **AND** a diff with a `potentially-breaking` change and no breaking change withholds the bump
  and emits a `signature-unprovable` finding of severity `warning`
