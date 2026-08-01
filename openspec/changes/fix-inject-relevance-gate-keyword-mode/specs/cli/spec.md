# cli spec delta

## ADDED Requirements

### Requirement: InjectionRelevanceGateIsDecidableInEveryShippedRetrievalMode

The task-scoped injection relevance gate SHALL have at least one satisfiable pass criterion in
every retrieval mode the product ships as a default or fallback (hybrid, keyword/BM25). A gate
criterion SHALL NOT compare an unbounded score to a fixed constant. In keyword mode the gate
SHALL accept scale-free evidence — at minimum, an exact identifier mention (the prompt contains a
matched function's exact name) — independent of hub status and fan-in, so small and young
repositories are not structurally excluded from injection.

#### Scenario: An exact identifier mention passes the gate in keyword mode

- **GIVEN** a freshly installed repository in zero-config keyword mode whose functions all have
  fan-in below the gate's fan-in criterion
- **WHEN** the `UserPromptSubmit` hook runs with a prompt that names an indexed function verbatim
  (e.g. "fix the bug where chargeCard rejects zero amounts")
- **THEN** `orient --inject` emits the full injection block, not the pointer line

#### Scenario: A genuinely weak match still degrades to the pointer line

- **GIVEN** the same repository
- **WHEN** the hook runs with a prompt whose tokens match no indexed identifier and whose
  matches carry no hub or fan-in evidence
- **THEN** the pointer line is emitted, and the behavior is unchanged from today

### Requirement: InjectionSuppressionIsObservable

When the relevance gate suppresses a full injection block, the gate verdict and the failing
criterion SHALL be observable under an opt-in debug switch, written to stderr only; stdout SHALL
carry nothing but the injected block or pointer line. Without the debug switch, output is
unchanged.

#### Scenario: Debugging why a block was suppressed

- **GIVEN** a prompt whose match fails the gate
- **WHEN** `orient --inject` runs with the debug switch enabled
- **THEN** stderr states the verdict (suppressed) and which criteria failed, and stdout contains
  only the pointer line
