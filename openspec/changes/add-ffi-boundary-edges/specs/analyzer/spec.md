# analyzer spec delta

## ADDED Requirements

### Requirement: FfiBindingsBecomeConfidenceTieredEdges

In a repository with two or more bound languages, the analyzer SHALL record declared cross-language
binding sites from a closed set (napi-rs, pyo3, wasm-bindgen, cgo `//export`) with file, line and
bound name, and SHALL join a foreign call to a binding by exact bound name into a synthesized edge
that names its producing rule. A bound name declared by more than one binding SHALL produce no edge
and a disclosed ambiguity. A foreign name computed at run time SHALL produce no edge and SHALL be
counted as an unresolved binding, disclosed through the confidence boundary of affected answers.
`blast_radius`, `orient`, test selection, dead-code detection and `verify_claim` SHALL read these
edges like any other synthesized edge. The capability matrix SHALL report `ffiBridges` only where a
live extractor backs it.

#### Scenario: A bound function is no longer falsely dead

- **GIVEN** a Rust function exported with `#[napi]` and called from TypeScript
- **WHEN** analysis runs
- **THEN** a synthesized edge with rule `ffi-napi` links the call to the function, `blast_radius`
  lists the TypeScript caller, and the function is not a clean dead-code candidate

#### Scenario: A computed name is disclosed, not guessed

- **GIVEN** a foreign call whose target name is built from a string at run time
- **WHEN** analysis runs
- **THEN** no edge is emitted and affected answers disclose an unresolved-binding count

#### Scenario: Ambiguity produces no edge

- **GIVEN** a foreign call whose bound name matches two binding declarations
- **WHEN** the join runs
- **THEN** no edge is emitted and the ambiguity is disclosed

#### Scenario: A single-language repository pays nothing

- **GIVEN** a repository with one language
- **WHEN** analysis runs
- **THEN** the pass is skipped and the capability matrix does not claim `ffiBridges`
