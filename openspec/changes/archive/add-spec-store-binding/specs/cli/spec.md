# cli spec delta

## ADDED Requirements

### Requirement: SpecStoreStatusCommand

The system SHALL provide a CLI command `openlore spec-store status` that resolves a configured spec-store
binding and emits its health check. The command SHALL support a `--json` flag whose output carries
stable finding codes documented in the agent-facing contract, so an external orchestrator can consume
the result without parsing prose. The command SHALL be read-only and SHALL exit zero whether or not
findings are present; it SHALL NOT block any workflow.

#### Scenario: Status emits machine-readable findings

- **GIVEN** a configured spec-store binding with one unresolved target
- **WHEN** `openlore spec-store status --json` is run
- **THEN** the command exits zero and emits a finding with the stable code `target-unresolved` and a
  remediation

#### Scenario: No binding configured

- **GIVEN** an environment with no spec-store binding
- **WHEN** `openlore spec-store status` is run
- **THEN** the command reports that no binding is configured and exits zero without error
