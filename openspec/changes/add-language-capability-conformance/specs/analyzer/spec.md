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
languages and the error-propagation overlay's claimed languages, and SHALL assert known cross-language
*precision* differences explicitly (e.g. import-precise versus name-only cross-file resolution) rather
than leaving them implicit.

#### Scenario: A claimed callGraph language is proven on real code

- **GIVEN** a language the registry lists in `CALLGRAPH_LANGUAGES`
- **WHEN** the conformance suite builds the call graph from a `caller→callee` fixture in that language
- **THEN** both functions are extracted and the `caller→callee` edge is resolved
- **AND** if any claimed callGraph language has no conformance fixture, the suite fails

#### Scenario: A cross-language precision difference is asserted, not hidden

- **GIVEN** a cross-file call in TypeScript versus in a name-only-resolved language (e.g. Python, Go)
- **WHEN** the conformance suite resolves each
- **THEN** the edge is found in every case
- **AND** TypeScript's provenance is asserted as import-precise while the name-only languages' lower-confidence provenance is documented explicitly
