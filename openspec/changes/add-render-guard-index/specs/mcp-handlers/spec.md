# Spec Delta

## ADDED Requirements

### Requirement: VisibilityIsAnsweredAsAConclusion

The system SHALL provide a tool that answers, for a named component or a named element within it,
what gates its appearance: the guard chain from the component's own early returns down to the
element's own condition, each guard's inputs with their classification, the writers of each input,
and the tests that reach those writers. The answer SHALL be the computed conclusion, not a graph for
the caller to traverse.

The tool SHALL declare one capability family and SHALL cross-reference its nearest sibling tools, as
every tool on this surface does. It SHALL answer the `what-gates` question kind, which the retrieval
abstention vocabulary otherwise reports as unserved.

#### Scenario: The guard chain is returned in order

- **GIVEN** a component with an early return and an element wrapped in a condition
- **WHEN** visibility for that element is requested
- **THEN** both guards are returned in evaluation order, each with its file, line and inputs

#### Scenario: Writers are named with their call sites

- **GIVEN** a guard input assigned by a setter and by a message-selected clause
- **WHEN** visibility is requested
- **THEN** both writers are returned with file, line and enclosing function

#### Scenario: An unknown component is an explicit not-found

- **GIVEN** a component name that is not in the index
- **WHEN** visibility is requested
- **THEN** the result is an explicit not-found with candidate names, never an empty guard list

#### Scenario: Boundaries are disclosed in the answer

- **GIVEN** a guard with an undetermined input or an unresolved writer
- **WHEN** visibility is requested
- **THEN** the answer discloses the boundary, so an empty writer set is never read as proof that
  nothing writes the input

#### Scenario: The unserved-kind disclosure is retired

- **GIVEN** a repository in a framework this tool supports
- **WHEN** a retrieval conclusion reports the `what-gates` question kind
- **THEN** it names this tool instead of stating that no tool answers that kind
