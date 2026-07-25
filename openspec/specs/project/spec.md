# Project Specification

> Source files: src/core/services/project-detector.ts

## Purpose

Detects the project type of an analyzed repository (Node.js/TypeScript, Python, Rust, Go, Java,
Ruby, PHP, or unknown) and maps each type key to its human-readable display name. Used to tailor
onboarding and language-aware defaults.

## Entities

### ProjectType

Represents the human-readable name of a project type.

**Properties:**

| Name | Type | Description |
|------|------|-------------|
| typeKey | string | The internal key representing the project type (e.g., 'nodejs', 'python'). |
| displayName | string | The human-readable name of the project type (e.g., 'Node.js/TypeScript', 'Python'). |
## Requirements
### Requirement: ProjectTypeValidation

The system SHALL validate ProjectType according to these rules:
- typeKey must be one of: 'nodejs', 'python', 'rust', 'go', 'java', 'ruby', 'php', 'unknown'
- displayName must be a non-empty string

#### Scenario: GetDisplayNameForNode.jsProjectType
- **GIVEN** The project type key is 'nodejs'
- **WHEN** getProjectTypeName is called with 'nodejs'
- **THEN** The display name is 'Node.js/TypeScript'

#### Scenario: GetDisplayNameForPythonProjectType
- **GIVEN** The project type key is 'python'
- **WHEN** getProjectTypeName is called with 'python'
- **THEN** The display name is 'Python'

#### Scenario: GetDisplayNameForUnknownProjectType
- **GIVEN** The project type key is 'unknown'
- **WHEN** getProjectTypeName is called with 'unknown'
- **THEN** The display name is 'Unknown'

### Requirement: TestSuiteHasNoKnownTimeBombs

The test suite SHALL contain no known deprecation warnings scheduled to become errors (a warning
of that class fails CI when introduced) and no known-flaky test left unfixed: a test observed to
fail intermittently under load SHALL be made deterministic (event-driven assertions or serial
isolation) with the fix verified by repeated full-suite runs, not quarantined indefinitely.

#### Scenario: A future vitest upgrade cannot flip green to red

- **GIVEN** the suite passing on the current vitest
- **WHEN** vitest promotes the vi.mock hoisting warning to an error
- **THEN** the suite still passes because no test triggers the warning

#### Scenario: A flake is fixed, not tolerated

- **GIVEN** a test that fails intermittently under full-suite load
- **WHEN** the fix lands
- **THEN** the PR records a repeated-run verification demonstrating determinism

## Technical Notes

- **Implementation**: `src/core/services/project-detector.ts`
