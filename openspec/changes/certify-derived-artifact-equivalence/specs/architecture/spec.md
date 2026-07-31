# architecture spec delta

## ADDED Requirements

### Requirement: PerformanceClaimsHoldWithinAPublishedCertifiedEnvelope

The system SHALL publish a certified scale envelope stating the repository size at which its
performance objectives hold, together with the objectives themselves for cold analysis, warm query
service, and single-file incremental publication.

Promoting the certified envelope to a larger size SHALL require the complete measurement matrix at
that size — cold build, warm query, single-file edit, file addition, file deletion, file rename,
and peak memory — and SHALL require the derived-artifact equivalence suite to pass at that size.
An envelope SHALL NOT be promoted on the strength of a single favourable measurement.

Operation beyond the certified envelope SHALL remain supported and SHALL be described as
best-effort. The system SHALL NOT describe an uncertified size as certified, and an uncertified
size SHALL NOT block improvements or releases within the current envelope.

Every published performance figure SHALL be labelled as measured or extrapolated and SHALL state
the reference machine it was obtained on. A figure SHALL NOT be published without that label.

#### Scenario: The envelope is stated, not implied

- **GIVEN** a user evaluating the system for a repository of a given size
- **WHEN** they read the published performance documentation
- **THEN** the certified repository size and its latency objectives are stated explicitly
- **AND** behaviour beyond that size is described as best-effort

#### Scenario: A tier promotion requires the whole matrix

- **GIVEN** a proposal to certify a larger repository size
- **WHEN** the promotion is reviewed
- **THEN** cold, warm, edit, add, delete, rename, and peak-memory measurements are all present at
  that size
- **AND** the equivalence suite passes at that size
- **AND** the promotion is refused if any element is missing

#### Scenario: A number without provenance is not published

- **GIVEN** a performance figure prepared for publication
- **WHEN** it lacks a measured-or-extrapolated label or a stated reference machine
- **THEN** it is not published in that form

#### Scenario: Beyond the envelope still works

- **GIVEN** a repository larger than the certified size
- **WHEN** the system is used on it
- **THEN** it produces the same correct answers
- **AND** its latency is presented as best-effort rather than as a certified objective
