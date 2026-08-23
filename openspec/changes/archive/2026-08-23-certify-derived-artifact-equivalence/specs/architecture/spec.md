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

The complete certified matrix SHALL be checked in as a machine-readable measurement manifest. The
published envelope SHALL be generated from that manifest. Every observed figure SHALL carry a `measured` or
`extrapolated` label, measurement date, reference environment, source command, and fixture identity.
An extrapolated figure SHALL additionally identify its measured basis and method. A figure SHALL
NOT be published without those provenance fields, and a generated envelope SHALL NOT omit a
required matrix operation.

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

#### Scenario: The published envelope is derived from the manifest

- **GIVEN** a checked-in certified-scale measurement manifest
- **WHEN** the published envelope is validated
- **THEN** every certified objective and measured matrix result matches the manifest
- **AND** no certified figure lacks fixture, date, command, environment, or measurement label

#### Scenario: Beyond the envelope still works

- **GIVEN** a repository larger than the certified size
- **WHEN** the system is used on it
- **THEN** the repository remains supported without a certified latency objective
- **AND** its performance is presented as best-effort rather than certified
