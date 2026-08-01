# analyzer spec delta

## ADDED Requirements

### Requirement: FlowSummariesAreCompositionalAndHashKeyed

The analyzer SHALL compute per-function value-flow summaries (parameter→return,
parameter→callee-argument, parameter→container-write) from the existing def-use overlay for the
supported languages (TypeScript/JavaScript/Python), memoized by the same content-hash key as
Pass-1 fact memoization so an edit refreshes only the changed functions' summaries. The
propagation rule set SHALL be closed (direct def-use, call-argument binding, return binding,
container-level writes) with no alias analysis: aliasing SHALL surface as a disclosed boundary
class, never a silent assumption in either direction. A function in an unsupported language
SHALL yield an explicit unsupported marker, never an empty summary presented as flow-free.

#### Scenario: An edit refreshes only its own summaries

- **GIVEN** a repository with computed flow summaries
- **WHEN** one function's body changes and the watcher processes the edit
- **THEN** only that function's summary is recomputed (hash-keyed), and all other summaries are
  served from the memo

#### Scenario: Unsupported languages are marked, not empty

- **GIVEN** a Go function in the traversal scope
- **WHEN** summaries are consulted
- **THEN** the function carries an explicit unsupported marker that downstream composition must
  surface as a boundary
