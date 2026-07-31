# openspec spec delta

## ADDED Requirements

### Requirement: ScenariosAreLintedForCheckableShape

The corpus lint SHALL check each scenario against a closed checkability grammar: a condition
clause (WHEN, optionally preceded by GIVEN), a THEN clause, and a THEN subject drawn from a
closed observable token-class list (quoted literal, tool or command name, symbol, field, or
numeric/comparative outcome). A failing scenario SHALL emit the registered advisory finding
`scenario-unverifiable-shape` quoting the failing clause. The lint SHALL judge shape only —
never semantic correctness — and SHALL remain advisory by default, with blocking available only
through the operator's enforcement policy.

#### Scenario: An unobservable THEN is flagged

- **GIVEN** a scenario whose THEN clause reads "THEN it works well"
- **WHEN** the corpus lint runs
- **THEN** a `scenario-unverifiable-shape` finding is emitted quoting that clause, and the run
  does not block

#### Scenario: A well-shaped scenario passes

- **GIVEN** a scenario with a WHEN condition and a THEN naming a quoted output and a field
- **WHEN** the corpus lint runs
- **THEN** no finding is emitted for that scenario
