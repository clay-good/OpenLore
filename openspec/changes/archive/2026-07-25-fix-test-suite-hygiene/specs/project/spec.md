# project spec delta

## ADDED Requirements

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
