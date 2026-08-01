# cli spec delta

## ADDED Requirements

### Requirement: FindingsAreEmittableAsSarifTransport

When invoked with `--sarif <path>`, `openlore enforce` and `openlore review` SHALL additionally
write their governance findings as a SARIF 2.1.0 log: registry codes as rules with their
source-declared descriptions, findings as results with messages verbatim and the resolved
enforcement class as a result property, subjects located by stored symbol spans (an
unresolvable subject carries a logical location only, never a fabricated line), and one run
stamped with the tool version and graph fingerprint. SARIF SHALL be transport, not policy: the
enforcement pipeline, existing outputs, and exit codes are byte-identical with or without the
flag, and emission SHALL be deterministic — the same findings and graph state produce a
byte-identical log.

#### Scenario: A finding lands as a locatable SARIF result

- **GIVEN** an advisory `cross-actor-conflict` finding whose subject symbol has a stored span
- **WHEN** `openlore enforce --sarif out.sarif` runs
- **THEN** the log contains the rule from the registry and a result with the message verbatim,
  the file and line from the span, and the resolved class `advisory` as a property — and the
  command's exit code equals the no-flag invocation's

#### Scenario: Emission is deterministic and honest about location

- **GIVEN** a finding whose subject cannot be resolved to a span, and two consecutive runs at
  a fixed repository state
- **WHEN** both runs emit SARIF
- **THEN** the two logs are byte-identical and the unresolvable subject appears with a logical
  location only
