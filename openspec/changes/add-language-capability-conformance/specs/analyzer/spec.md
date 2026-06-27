# analyzer spec delta

## ADDED Requirements

### Requirement: CapabilityMatrixIsConformanceVerified

The per-language capability matrix surfaced by `get_language_support` (derived from the per-capability
`*_LANGUAGES` constants) SHALL be verified against the real extractors, not merely asserted. For every
language the registry claims supports `callGraph`, a committed conformance fixture SHALL drive the
actual call-graph builder and demonstrate that a realistic `caller→callee` fixture yields both
functions and the resolved edge. The conformance suite SHALL also fail if the registry adds a
`callGraph` language for which no fixture exists, so the matrix can never silently grow to over-claim.

The conformance suite SHALL additionally verify intra-class method dispatch for class-bearing
languages, the richer overlays (CFG, type inference, style fingerprint, cross-service HTTP) for each
of their claimed languages, the IaC projection for every ecosystem in `IAC_LANGUAGES`, and the
error-propagation overlay's claimed languages, and SHALL assert known cross-language *precision*
differences explicitly (e.g. import-precise versus name-only cross-file resolution) rather than
leaving them implicit. For every capability with a closed claimed-language set, the suite SHALL fail
if that set grows without a corresponding fixture, so no capability can silently over-claim.

#### Scenario: A claimed callGraph language is proven on real code

- **GIVEN** a language the registry lists in `CALLGRAPH_LANGUAGES`
- **WHEN** the conformance suite builds the call graph from a `caller→callee` fixture in that language
- **THEN** both functions are extracted and the `caller→callee` edge is resolved
- **AND** if any claimed callGraph language has no conformance fixture, the suite fails

#### Scenario: A richer overlay is proven on each claimed language and honestly absent otherwise

- **GIVEN** one of the richer capabilities (CFG, type inference, style fingerprint, cross-service HTTP) and a language the registry claims supports it
- **WHEN** the conformance suite drives that capability's real extractor against a representative fixture
- **THEN** the capability produces a non-empty result for the claimed language
- **AND** a non-claimed language yields an empty/absent result (never a guessed signal), and any claimed language without a fixture fails the suite

#### Scenario: Every claimed IaC ecosystem projects onto graph primitives

- **GIVEN** an ecosystem in `IAC_LANGUAGES` and a minimal realistic fixture for it
- **WHEN** the conformance suite runs the real projector over the fixture
- **THEN** the fixture's resources/jobs/tasks become graph nodes, and where the ecosystem models a cross-reference a `references`/`depends_on` edge is produced
- **AND** if `IAC_LANGUAGES` grows without a fixture, the suite fails

#### Scenario: A cross-language precision difference is asserted, not hidden

- **GIVEN** a cross-file call in TypeScript versus in a name-only-resolved language (e.g. Python, Go)
- **WHEN** the conformance suite resolves each
- **THEN** the edge is found in every case
- **AND** TypeScript's provenance is asserted as import-precise while the name-only languages' lower-confidence provenance is documented explicitly
