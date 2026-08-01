# analyzer spec delta

## ADDED Requirements

### Requirement: FfiBindingsBecomeConfidenceTieredEdges

In repositories with two or more bound languages, the system SHALL extract declared
cross-language binding constructs from a closed initial set (attribute- or macro-declared
exports, explicit registration calls, and convention-named symbols) as boundary facts with file
and line receipts, and SHALL join caller-side foreign calls to binding declarations by exact
bound name into a dedicated FFI edge lane. Every FFI edge SHALL carry a confidence tier
reflecting its evidence class — attribute-declared above convention-name, both below resolved
same-language edges — and the name of the producing rule. An ambiguous join SHALL refuse rather
than bind a first match. Foreign names that are computed rather than declared SHALL produce no
edge and SHALL be counted as unresolved-binding boundaries, disclosed on affected conclusions
through the existing confidence-boundary contract. Consumers SHALL inherit the lane: a symbol
called only across the boundary is not a clean dead-code candidate, and reachability-based
conclusions cross the seam carrying the edge's confidence. The language-support capability
matrix SHALL report FFI-bridge support only where a live extractor backs it.

#### Scenario: A bound symbol stops being falsely dead

- **GIVEN** a Rust function exported via an attribute-declared binding and called from
  TypeScript
- **WHEN** analysis runs and dead code is computed
- **THEN** an FFI edge with the attribute-declared tier and its rule name links the call to the
  function, and the function is not listed as a clean dead-code candidate

#### Scenario: A computed name is a boundary, not a guess

- **GIVEN** a foreign call whose target name is built from a string at runtime
- **WHEN** analysis runs
- **THEN** no FFI edge is emitted and affected conclusions disclose an unresolved-binding
  boundary count

#### Scenario: Ambiguity refuses

- **GIVEN** a foreign call whose bound name matches two binding declarations
- **WHEN** the join runs
- **THEN** no edge is emitted and the ambiguity is disclosed

#### Scenario: The matrix cannot over-claim the seam

- **GIVEN** a language with no FFI extractor
- **WHEN** the capability matrix is generated
- **THEN** its FFI-bridge cell is not claimed, and single-language repositories skip the pass
  entirely
