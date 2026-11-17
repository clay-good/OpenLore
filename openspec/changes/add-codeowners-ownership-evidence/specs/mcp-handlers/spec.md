# mcp-handlers spec delta

## ADDED Requirements

### Requirement: OwnershipEvidenceJoinsExistingConclusions

`blast_radius` SHALL report the declared owners of a diff's changed files and affected-caller files
in an `ownership` field, as names and file counts with no score, and `verify_change` SHALL show the
owners to raise the change to. No tool SHALL be added for this. The system SHALL register an
advisory `unowned-critical-path` finding code, emitted when the diff changes a symbol that carries
the existing `hub` or `chokepoint` label in a file no CODEOWNERS rule covers. When no CODEOWNERS
file exists, `ownership` SHALL state that ownership was not assessed, and the finding SHALL NOT be
emitted.

#### Scenario: A change that crosses owners names them

- **GIVEN** a diff whose changed and affected files resolve to `@org/api-team` and `@org/infra`
- **WHEN** `blast_radius` and `verify_change` run
- **THEN** `ownership` names both owners with their file counts, and the `verify_change` receipt
  lists both under "raise to"

#### Scenario: A changed hub with no owner is an advisory finding

- **GIVEN** a diff that changes a function labeled `hub`, in a file no rule matches
- **WHEN** `blast_radius` runs
- **THEN** an `unowned-critical-path` finding names the symbol and file, and it is advisory unless
  the enforcement policy says otherwise

#### Scenario: No CODEOWNERS is not "unowned"

- **GIVEN** a repository with no CODEOWNERS file
- **WHEN** `blast_radius` runs
- **THEN** `ownership` says "not assessed (no CODEOWNERS)" and no finding is emitted
