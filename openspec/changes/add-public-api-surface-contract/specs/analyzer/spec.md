# analyzer spec delta

## ADDED Requirements

### Requirement: PublicSurfaceExtraction

The system SHALL identify the **public surface** of a package or module — the symbols reachable through
its declared public entry points (the package manifest's `exports`/`main`/`types`, public index
barrels, and language-level visibility such as the `export` keyword or `public`/`pub` modifiers) — and
SHALL record each surface symbol with its signature: name, parameter list (names, order, optionality,
and types where statically available), return type where available, and kind. Entry-point discovery and
visibility rules SHALL be gated per language through the language-support registry, so coverage is
observable and fail-soft for unsupported languages. Public-surface extraction SHALL run no type checker,
compiler, or build, and SHALL be a deterministic function of the indexed state.

#### Scenario: Exported symbols and their signatures form the public surface

- **GIVEN** a package whose manifest exports an entry module that re-exports two functions and a type
- **WHEN** the repository is analyzed
- **THEN** the public surface contains those two functions and the type, each with its extracted
  signature, and excludes internal symbols not reachable through a public entry point

### Requirement: DeterministicBreakingChangeClassification

Given a base and a changed state, the system SHALL classify each public-surface symbol's change into a
fixed, closed set: `breaking`, `non-breaking`, or `potentially-breaking`. A removed or renamed export, an
added required parameter, a removed or newly-required existing parameter, a narrowed parameter or return
type, or a reduced visibility SHALL classify as `breaking`. An added trailing optional parameter, a new
export, or a widened return type SHALL classify as `non-breaking`. A change whose compatibility cannot be
proven from the statically-available type information SHALL classify as `potentially-breaking` and SHALL
NOT be folded into `non-breaking`. A renamed export SHALL be reported as a rename (via the rename/move
continuity map), not as a removal plus an addition. The classification SHALL be a pure function of the
two indexed states — byte-identical across re-runs.

#### Scenario: A removed export is breaking

- **GIVEN** a public-surface function present in the base and absent in the changed state, with no
  continuity match
- **WHEN** the diff is classified
- **THEN** the change is `breaking` (export removed)

#### Scenario: A renamed export is a rename, not a remove-plus-add

- **GIVEN** a public-surface function whose name changed but whose body is identical, matched by the
  continuity map
- **WHEN** the diff is classified
- **THEN** the change is reported as a rename of that export (still a `breaking` contract change, but
  named as a rename with its new name), not as one removal and one unrelated addition

#### Scenario: An unprovable change is potentially-breaking, never silently safe

- **GIVEN** a change to an export whose signature is dynamically typed, so compatibility cannot be proven
- **WHEN** the diff is classified
- **THEN** the change is `potentially-breaking` with a disclosure of why, not `non-breaking`

#### Scenario: A trailing optional parameter is non-breaking

- **GIVEN** an exported function that gains a new optional parameter at the end of its parameter list
- **WHEN** the diff is classified
- **THEN** the change is `non-breaking`
