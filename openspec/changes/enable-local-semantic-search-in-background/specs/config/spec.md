# Spec Delta

## ADDED Requirements

### Requirement: RetrievalUpgradeHintsAreForHumans

Responses read by an agent SHALL report the served retrieval mode without advice to change it. A
suggestion to enable semantic embeddings SHALL appear only on human-facing surfaces (`openlore
status`, `openlore doctor`), and SHALL NOT appear when keyword mode is the configured default and
working.

#### Scenario: A keyword answer carries no upgrade advice

- **GIVEN** a repository on the default keyword index
- **WHEN** `orient` answers
- **THEN** the response reports `retrievalMode` and contains no suggestion to run `openlore embed`

### Requirement: LocalSemanticIsBuiltInTheBackgroundWhenItMeasurablyHelps

Local semantic vectors SHALL be built by default only after a recorded retrieval benchmark shows a
recall@5 gain of at least 5 points over keyword-with-vocabulary retrieval, with no regression on any
corpus. When enabled, the keyword index SHALL be served first and vectors added in the background;
answers SHALL report `local-semantic` only once vectors for the current generation exist. A missing
package or model SHALL leave keyword serving with no error.

#### Scenario: Semantic arrives without waiting

- **GIVEN** a new repository, local semantic enabled by default, and the optional package present
- **WHEN** the first `orient` call runs after the keyword index is published
- **THEN** it answers in keyword mode at once, and a later call after the vector pass answers in
  `local-semantic` mode

#### Scenario: No measured win, no default

- **GIVEN** a benchmark result below the threshold
- **WHEN** a repository is auto-initialized
- **THEN** no vectors are built and the keyword index is the served default

### Requirement: AnExplicitKeywordChoiceAlwaysWins

An explicit opt-out (`embedding.provider: "none"`, `openlore embed --off`, or `--no-embed`) SHALL
always win over the background semantic default.

#### Scenario: An opted-out repository builds no vectors

- **GIVEN** a repository with `embedding.provider: "none"`
- **WHEN** it is auto-initialized or repaired
- **THEN** no vectors are built and answers report keyword mode
