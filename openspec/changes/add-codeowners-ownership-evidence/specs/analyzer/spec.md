# analyzer spec delta

## ADDED Requirements

### Requirement: CodeownersResolutionIsDeclarativeAndDialectHonest

The system SHALL resolve declared file ownership from the repository's local CODEOWNERS file as a
pure function of the file path: GitHub-format patterns applied last-match-wins, with no git
history, no network call and no model. A repository with no CODEOWNERS file SHALL yield an explicit
"not assessed" result, and ownership SHALL never be inferred from authorship. A file in an
unsupported format SHALL yield an explicit unsupported-format result and no owner map. A single
rule that cannot be parsed SHALL be skipped and counted.

#### Scenario: The last matching rule wins

- **GIVEN** a CODEOWNERS with `* @org/core` followed by `src/api/ @org/api-team`
- **WHEN** ownership is resolved for `src/api/routes.ts`
- **THEN** the owner is `@org/api-team`, and no git state is read

#### Scenario: An unsupported format is reported, not guessed

- **GIVEN** a CODEOWNERS file that uses GitLab section syntax
- **WHEN** the resolver parses it
- **THEN** the result names the format as unsupported and serves no owner map
