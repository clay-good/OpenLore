# drift spec delta

## ADDED Requirements

### Requirement: CorpusIntentDeltaIsReviewedBetweenRefs

The system SHALL review changes to the governance corpus between two references and report, as
registered findings, the deterministic ways the corpus's declared intent was weakened. The rules
SHALL be a closed, source-declared table over the parsed requirement and scenario structure, and
SHALL cover at minimum: a requirement's strongest normative keyword dropping a rank; a requirement
losing scenarios; a requirement disappearing; a measurable clause present in the base text being
absent from the head text of the same requirement; a disclosed-boundary clause being deleted; a
decision's status regressing without a recorded superseder; and a change delta whose target
requirement disappeared.

Every comparison SHALL be structural. The system SHALL NOT use a similarity model, an embedding, a
language model, or any scoring heuristic to decide whether intent was weakened. Where a requirement
may have been renamed, the system SHALL match continuity by exact name first and by an identical
scenario set second; when neither matches, the change SHALL be reported as a removal and SHALL NOT
be presented as a rename.

The review SHALL conclude with a verdict of either review-recommended or no-review-needed, and when
review is recommended SHALL list each reason as the finding that produced it. The system SHALL NOT
emit a numeric score, weighted severity, ranking, or confidence value for a corpus change. Findings
SHALL default to the advisory enforcement class and SHALL become blocking only through the
operator's enforcement policy.

Base and head revisions SHALL be materialized read-only: the review SHALL NOT create a worktree,
perform a checkout, or mutate the repository index or `HEAD`, so that concurrent runs and a
developer's working tree are unaffected. The review SHALL be deterministic and offline: the same
two corpus states SHALL produce a byte-identical finding list and verdict, with no clock, no
randomness, and no network in the path.

#### Scenario: A weakened normative keyword is caught

- **GIVEN** a requirement stating `The system SHALL reject the request`
- **WHEN** the head revision states `The system SHOULD reject the request`
- **THEN** a `corpus-normative-weakened` finding names the requirement and both keywords
- **AND** the verdict is review-recommended, citing that finding as a reason

#### Scenario: A deleted scenario is caught even though the requirement still validates

- **GIVEN** a requirement with three scenarios in the base revision
- **WHEN** the head revision keeps the requirement with one scenario
- **THEN** a `corpus-scenario-removed` finding names the requirement and the removed scenarios
- **AND** the finding is emitted even though the head requirement passes structural validation

#### Scenario: A measurable clause replaced by vague prose is caught

- **GIVEN** a requirement whose base text names a numeric threshold with a unit
- **WHEN** the head text of the same requirement no longer contains that measurable clause
- **THEN** a `corpus-specificity-lost` finding names the requirement and the clause that
  disappeared

#### Scenario: An unmatched rename is reported as a removal, not guessed

- **GIVEN** a requirement present in the base revision and absent in the head revision
- **AND** no head requirement shares its name or its exact scenario set
- **WHEN** the review runs
- **THEN** a `corpus-requirement-removed` finding is emitted
- **AND** no rename is asserted

#### Scenario: An unchanged corpus needs no review

- **GIVEN** two references whose corpus artifacts are byte-identical
- **WHEN** the review runs
- **THEN** no findings are emitted and the verdict is no-review-needed

#### Scenario: Review never mutates the repository

- **GIVEN** a review invoked against a base reference while the working tree holds uncommitted
  changes
- **WHEN** the review runs
- **THEN** the working tree, index, and `HEAD` are unchanged afterwards
- **AND** a second review running concurrently produces the same result

#### Scenario: Findings stay advisory until an operator says otherwise

- **GIVEN** a corpus change producing intent findings under the default policy
- **WHEN** the enforcement gate runs
- **THEN** the findings are reported and the gate does not fail
- **AND** promoting a finding code to the blocking class in the operator's policy makes that code,
  and only that code, fail the gate
