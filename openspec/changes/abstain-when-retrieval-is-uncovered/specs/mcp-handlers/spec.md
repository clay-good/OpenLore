# Spec Delta

## ADDED Requirements

### Requirement: RetrievalHandlersCarryTheCoverageVerdict

Every handler whose answer is produced by retrieval — code search, spec search, and the symbol
selection inside the orientation briefing — SHALL carry the coverage verdict and, when the verdict is
not `covered`, the question-kind disclosure. The verdict SHALL be part of the handler's structured
output, subject to the same dispatch-time shape enforcement as the rest of the conclusion contract.

#### Scenario: Search carries its verdict

- **GIVEN** any code or spec search request
- **WHEN** the handler responds
- **THEN** the structured output carries a coverage verdict

#### Scenario: Orientation states when it found nothing relevant

- **GIVEN** a task description whose terms match no indexed symbol beyond noise
- **WHEN** the orientation briefing is produced
- **THEN** it reports that the task is not covered by the index instead of listing its highest-ranked
  unrelated symbols, and the rest of the briefing (specs, decisions, staleness) is still returned

#### Scenario: The verdict survives the dispatch contract check

- **GIVEN** a retrieval-backed handler whose output omits the verdict
- **WHEN** the conclusion shape is enforced at dispatch
- **THEN** the omission is reported as a contract violation

### Requirement: InsertionPointsWithholdRecommendationWithoutStrongEvidence

`suggest_insertion_points` SHALL NOT recommend a location when the retrieval that produced its
candidates carries an `uncovered` verdict. It SHALL return the abstention with its reason and the
question kind, because a confidently-named wrong insertion point costs more than no answer.

When the verdict is `weak`, the tool SHALL return its candidates — they remain worth inspecting —
but SHALL withhold the action recommendation built on them: the per-candidate insertion strategy and
the next-step instructions SHALL be absent, and the coverage disclosure SHALL be present. Naming a
location is information; telling an agent how to edit it is advice, and advice resting on incidental
evidence is what produced a recommended edit inside an unrelated function.

#### Scenario: No insertion point is invented for an uncovered task

- **GIVEN** a feature description whose retrieval verdict is `uncovered`
- **WHEN** insertion points are requested
- **THEN** no location is recommended, and the response states that the task is not covered

#### Scenario: A weak verdict returns locations without advice

- **GIVEN** a feature description whose every candidate rests on incidental evidence
- **WHEN** insertion points are requested
- **THEN** the candidates are returned with the coverage disclosure, and no candidate carries an
  insertion strategy and no next-step instructions are returned

#### Scenario: A covered task is unaffected

- **GIVEN** a feature description whose retrieval verdict is `covered`
- **WHEN** insertion points are requested
- **THEN** locations are recommended exactly as before this requirement, each with its insertion
  strategy and the next steps
