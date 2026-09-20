# Spec Delta

## Purpose

Record which conditions gate each rendered interface element, and which code writes those
conditions' inputs, so the question "what makes this appear or disappear" is answered structurally
instead of by ranking components against a query string.

## ADDED Requirements

### Requirement: RenderGuardsAreExtractedFromStaticConditions

The analyzer SHALL extract, for each rendered element it can identify, the conditions that gate the
element's presence, deriving each guard from the syntax alone: a logical-and expression wrapping the
element, a conditional expression whose branches include it, and an early return that prevents the
element from rendering. Each guard SHALL record the source file, the line of the condition, and the
element it gates.

Extraction SHALL be deterministic and SHALL NOT use an LLM. A condition the analyzer cannot reduce to
identifiers — an opaque call, a computed member access — SHALL be recorded as a guard with an
undetermined input, never dropped and never guessed.

#### Scenario: A logical-and guard is recorded

- **GIVEN** a component rendering `{isRunning && <Spinner/>}`
- **WHEN** the repository is analyzed
- **THEN** a guard is recorded for `Spinner` naming the condition, its file and its line

#### Scenario: Both branches of a conditional are recorded

- **GIVEN** a component rendering `cond ? <Running/> : <Idle/>`
- **WHEN** the repository is analyzed
- **THEN** one guard records `Running` under the condition and one records `Idle` under its negation

#### Scenario: An early return is a guard

- **GIVEN** a component whose body begins `if (!ready) return null`
- **WHEN** the repository is analyzed
- **THEN** every element in that component records `ready` as a gating condition

#### Scenario: An opaque condition is recorded as undetermined

- **GIVEN** a guard whose condition is the result of an unresolvable call
- **WHEN** the repository is analyzed
- **THEN** the guard is recorded with an undetermined input and is not silently omitted

### Requirement: GuardInputsAreClassifiedAndPairedWithTheirWriters

Each guard SHALL record the identifiers its condition reads, classified as prop, local state,
store or context value, or derived from other identifiers. For each input, the system SHALL record
the writers that assign it — a state setter call, a reducer clause assigning the field, or a store
mutation — with the file, line and enclosing function of each writer.

A writer that cannot be resolved SHALL be recorded as unresolved with its reason. An input with no
recorded writer SHALL NOT be presented as never written; the absence SHALL be reported as an
unresolved write path.

#### Scenario: A state input names its setter

- **GIVEN** a guard reading a value declared by a state hook and assigned by a setter elsewhere
- **WHEN** the repository is analyzed
- **THEN** the setter call site is recorded as that input's writer

#### Scenario: A reducer clause is a writer

- **GIVEN** a guard reading a field assigned inside a handler clause selected by a message tag
- **WHEN** the repository is analyzed and message-topology recovery is available
- **THEN** that clause is recorded as the input's writer

#### Scenario: An unresolved writer is disclosed

- **GIVEN** a guard input assigned through a path the analyzer cannot follow
- **WHEN** the repository is analyzed
- **THEN** the input records an unresolved write path with its reason, not an empty writer list
  presented as complete

### Requirement: RenderGuardSupportIsDeclaredPerFramework

Render-guard extraction SHALL be declared per framework and language, so a component in an
unsupported framework yields an explicitly unsupported result rather than an empty guard list. A
framework SHALL be declared supported only where an implemented collector recovers its gating syntax.

#### Scenario: An unsupported framework says so

- **GIVEN** a component written in a framework with no guard collector
- **WHEN** its guards are requested
- **THEN** the result states that guard extraction is unsupported for that framework

#### Scenario: A supported framework is declared from its implementation

- **GIVEN** the framework whose collector this change implements
- **WHEN** the capability matrix is queried
- **THEN** render-guard extraction is reported supported for that framework only
