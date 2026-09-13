# cli spec delta

## ADDED Requirements

### Requirement: FindingsAreEmittableAsSarifTransport

When invoked with `--sarif <path>`, `openlore enforce` and `openlore review` SHALL additionally
write the governance findings they classified as a SARIF 2.1.0 log: every registered finding code
as a rule with its registry description, each finding as a result with its message verbatim, a
level from a fixed severity table, and its resolved enforcement class as a result property. A
finding with a recorded repository-relative location SHALL carry a physical location, with a line
only when the source recorded one; any other finding SHALL carry a logical location named by its
subject, never a fabricated line. The run SHALL be stamped with the tool version and, when an index
exists, the call-graph fingerprint. SARIF SHALL be transport, not policy: the command's printed
output and exit code SHALL be the same with or without the flag, a write failure SHALL only warn,
and emission SHALL be deterministic — the same findings, version, and graph produce a byte-identical
log.

#### Scenario: A located finding lands as a SARIF result

- **GIVEN** a classified finding with a recorded location `src/a.ts` line 12
- **WHEN** the SARIF log is written
- **THEN** it contains the finding's rule from the registry and a result with the message verbatim,
  the file and line, and the resolved enforcement class as a property

#### Scenario: Transport does not change the command

- **GIVEN** `openlore enforce --json` run with and without `--sarif out.sarif`
- **WHEN** both runs complete
- **THEN** stdout and the exit code are identical, and `out.sarif` is a SARIF 2.1.0 log

#### Scenario: Emission is deterministic and honest about location

- **GIVEN** a finding with no recorded location and the same findings serialized twice in a
  different order
- **WHEN** both logs are produced
- **THEN** the two logs are byte-identical and the finding carries a logical location only
