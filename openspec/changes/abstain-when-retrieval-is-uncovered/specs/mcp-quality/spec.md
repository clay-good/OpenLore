# Spec Delta

## ADDED Requirements

### Requirement: NoFalseCoverage

A retrieval-backed conclusion SHALL NOT be shaped like an answered question when its results rest on
evidence too weak to answer it. Every such conclusion SHALL carry a coverage verdict derived from the
match evidence already attached to its results: `covered`, `weak`, or `uncovered`. A conclusion whose
verdict is `uncovered` SHALL NOT return a ranked list of results; it SHALL return the reason and the
remedy. A conclusion whose verdict is `weak` MAY return results, and SHALL state that every result
rests on low-tier evidence.

The verdict SHALL be computed from the existing evidence tiers, with no relevance threshold, no new
score, and no LLM. This is the coverage counterpart to `NoFalseCompleteness`: a caller can always
tell "this is what you asked for" from "this is the closest thing I hold."

#### Scenario: An uncovered question returns no ranked list

- **GIVEN** a query whose every candidate result matches only on incidental, low-tier evidence
- **WHEN** a retrieval-backed conclusion is produced
- **THEN** the verdict is `uncovered`, no ranked results are returned, and the response names why
  and what would answer it

#### Scenario: Weak coverage is stated, not hidden

- **GIVEN** a query whose results all rest on low-tier evidence but are not noise
- **WHEN** the conclusion is produced
- **THEN** the verdict is `weak` and the response states that every result rests on low-tier evidence

#### Scenario: A covered question is unchanged

- **GIVEN** a query with at least one result matching on a strong field
- **WHEN** the conclusion is produced
- **THEN** the verdict is `covered` and the result set is the same as before this requirement

#### Scenario: The verdict is derived, not tuned

- **GIVEN** two runs of the same query against the same index
- **WHEN** the verdict is computed
- **THEN** both produce the identical verdict, from the evidence tiers alone, with no configurable
  relevance threshold involved

### Requirement: UnservedQuestionKindsAreNamed

A conclusion whose coverage verdict is `weak` or `uncovered` SHALL name the kind of question it could
not serve, from a closed vocabulary: `where-is`, `who-calls`, `what-gates`, `what-order`,
`is-it-tested`, `why-decided`. When another shipped tool answers that kind, the response SHALL name
that tool. When no shipped tool answers it, the response SHALL say so plainly rather than offering a
substitute.

#### Scenario: A structural question is routed to the tool that answers it

- **GIVEN** an uncovered query asking which functions call a symbol
- **WHEN** the conclusion is produced
- **THEN** the question kind `who-calls` is named together with the tool that answers it

#### Scenario: An unserved kind is admitted

- **GIVEN** an uncovered query asking what makes a piece of interface appear
- **WHEN** the conclusion is produced
- **THEN** the question kind `what-gates` is named and the response states that no shipped tool
  answers it, offering no substitute ranking

#### Scenario: The vocabulary is closed

- **GIVEN** any conclusion carrying a question-kind disclosure
- **WHEN** the value is read
- **THEN** it is one of the six defined kinds, and an unrecognized kind is a contract violation
