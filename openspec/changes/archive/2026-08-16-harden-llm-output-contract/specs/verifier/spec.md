# verifier spec delta

## ADDED Requirements

### Requirement: LlmJudgedScoresCarryProvenance

Any verification metric derived from an LLM's self-reported judgment (such as
`specAccuracyScore`) SHALL be labeled with its provenance in verifier output — `llm-judged`
plus the judging model's id. A deterministic comparison that consumes an LLM prediction,
such as export matching, SHALL identify both the deterministic comparison and the prediction's
model. Fully deterministic checks SHALL remain separately attributed. The verifier SHALL NOT
blend these inputs into an undifferentiated score: any mixed composite SHALL publish its
evidence basis and weights. When no LLM judgment is available, a deterministic fallback
(keyword overlap) SHALL be labeled as such, so a reader can always tell measurement from
opinion.

#### Scenario: An LLM-judged score is labeled

- **GIVEN** a verification run where the LLM returned a `specAccuracyScore` for a file
- **WHEN** the verification report is rendered
- **THEN** the score carries a `llm-judged` provenance label with the model id, distinct from
  the deterministic sub-check results

#### Scenario: The fallback is not passed off as a judgment

- **GIVEN** a verification run where no LLM score is available for a file
- **WHEN** the keyword-overlap fallback supplies the similarity
- **THEN** the score is labeled as the deterministic fallback, and no LLM provenance is
  implied

#### Scenario: No blended number

- **GIVEN** a report containing both LLM-judged and deterministic results
- **WHEN** summary metrics are computed
- **THEN** each summary line attributes its inputs; no single figure silently mixes
  LLM-judged and deterministic components

#### Scenario: A deterministic comparison names its LLM operand

- **GIVEN** export matching deterministically compares source exports with an LLM-predicted
  export list
- **WHEN** the verification result or report is rendered
- **THEN** the metric is labeled as a deterministic comparison over an LLM prediction and
  carries the prediction model's id
