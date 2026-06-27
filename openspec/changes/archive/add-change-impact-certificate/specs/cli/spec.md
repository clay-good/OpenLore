# cli spec delta

## ADDED Requirements

### Requirement: ImpactCertificateCommand

The system SHALL provide a CLI command `openlore impact-certificate` that computes and emits the impact
certificate for a proposed change in a configured spec-store binding. The command SHALL support
`--change <id>` to select the change, `--json` whose output carries stable surface and path codes
documented in the agent-facing contract, and the advisory git-hook flags (`--hook`, `--install-hook`,
`--uninstall-hook`) following the existing pre-flight hook pattern. The certificate SHALL be advisory by
default: the command and its hook SHALL NOT block. A repository MAY opt into blocking for specific
high-severity surface findings via configuration, but blocking SHALL never be the default, and
infrastructure failure (no graph, no binding) SHALL never block.

#### Scenario: Default certificate is advisory

- **GIVEN** the impact-certificate hook installed with default configuration
- **WHEN** a commit is made for a change that opens a new path into a declared surface
- **THEN** the certificate is emitted and the commit is not blocked

#### Scenario: Opt-in blocking fires only on its configured severity

- **GIVEN** a repository configured to block when a change opens a new path into a surface marked
  critical
- **WHEN** a change opens a new path into a critical surface
- **THEN** the hook blocks; and for a newly-opened path into any non-critical surface it remains advisory
