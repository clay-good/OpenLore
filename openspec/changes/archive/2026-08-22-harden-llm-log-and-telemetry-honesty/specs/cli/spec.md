# cli spec delta

## ADDED Requirements

### Requirement: TelemetryGateAndDisclosureAreHonest

The telemetry opt-in gate SHALL enable telemetry only for an explicitly truthy value and
SHALL NOT treat `0`/`false` as enabling. The user-facing disclosure SHALL enumerate every
domain telemetry records (tool calls with agent identity and latency, error message strings,
decision titles, and lease events), not only the lease-measurement framing, and SHALL note
the local-only, gitignored, rotated bound.

#### Scenario: Opting out actually opts out

- **GIVEN** `OPENLORE_TELEMETRY=0` in the environment
- **WHEN** any telemetry-emitting path runs
- **THEN** no telemetry is written

#### Scenario: The disclosure matches what is recorded

- **GIVEN** the telemetry documentation
- **WHEN** a user reads what telemetry collects
- **THEN** it enumerates the recorded domains including error strings and decision titles,
  so the disclosure is not narrower than the content
