# mcp-handlers spec delta

## ADDED Requirements

### Requirement: EditsAfterTheLastTestRunAreNamed

When the harness payloads delivered to OpenLore's after-tools hook (which receives every tool
call, not only edits) include a shell command that
matches a test command the repository declares (a package test script, a CI run step, a test build
target) or a runner from a closed list, the session ledger SHALL record the time of the run, its exit
status when the payload carries one, and the content hashes of the session's edited symbols at that
moment. The before-stop receipt SHALL name the symbols edited after the most recent recorded run and
the tests that reach them. The system SHALL NOT run any test. When no hook payloads were received,
the fact SHALL be withheld and the reason stated.

#### Scenario: An edit after the test run is named

- **GIVEN** a session that edits `parseConfig`, runs `npm test`, then edits `loadDefaults`
- **WHEN** the before-stop hook runs
- **THEN** the receipt names `loadDefaults` and the tests that reach it, and does not name
  `parseConfig`

#### Scenario: No payloads means no claim

- **GIVEN** a harness that delivers no after-tools payloads
- **WHEN** the before-stop receipt is built
- **THEN** it states that test runs are not observed, rather than naming every edited symbol
