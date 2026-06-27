# cli spec delta

## ADDED Requirements

### Requirement: WorkingSetContextCommand

The system SHALL provide a CLI command `openlore working-set context` that assembles and emits the
working-set structural briefing for an active change in a configured spec-store binding. The command
SHALL accept the change to brief (for example `--change <id>`) and SHALL support a `--json` flag whose
output is documented in the agent-facing contract, so an external orchestrator can request the briefing
and splice it into the context it hands its agent. The command SHALL be read-only.

#### Scenario: Briefing emitted as machine-readable context

- **GIVEN** a bound store with an active change targeting two repositories
- **WHEN** `openlore working-set context --change <id> --json` is run
- **THEN** the command emits one budgeted briefing whose items are attributed to each target repository,
  in the documented JSON shape, and exits zero
