# mcp-handlers spec delta

## ADDED Requirements

### Requirement: DeprecatedSymbolUseIsAnAdvisoryFinding

`structural_diff` SHALL report each call edge the diff adds whose target carries a deprecation
marker, with caller, caller file and line, target, target file, the target's hint, and how the
target was resolved — no new tool. The target SHALL be resolved only from a symbol in the re-parsed
changed files, from the analyzed index's edge for the same caller and callee name when it names
exactly one internal symbol, or, for a plain call with no receiver, from the only internal symbol
with that name; anything else SHALL NOT be checked, and the response SHALL say which calls are
checked. A call already present before the diff SHALL NOT be reported. Each reported call SHALL be a
`deprecated-symbol-use` finding registered in `FINDING_CODE_REGISTRY`, advisory by default and
blocking only through an operator's `enforcement.policy`.

#### Scenario: A diff adding a call into a deprecated symbol is flagged, advisory

- **GIVEN** a working-tree diff that adds a call to a function marked deprecated
- **WHEN** `structural_diff` runs on the diff
- **THEN** the new call is reported with caller, target, location, hint, and resolution
- **AND** a `deprecated-symbol-use` finding is returned with advisory class by default

#### Scenario: Pre-existing deprecated calls do not fire the finding

- **GIVEN** a call into a deprecated symbol that existed before the diff
- **WHEN** `structural_diff` runs on a diff that does not add it
- **THEN** no deprecated call and no `deprecated-symbol-use` finding is reported

#### Scenario: An ambiguous name is not guessed

- **GIVEN** a new plain call whose name matches two internal symbols, one of them deprecated
- **WHEN** `structural_diff` runs
- **THEN** the call is not reported
