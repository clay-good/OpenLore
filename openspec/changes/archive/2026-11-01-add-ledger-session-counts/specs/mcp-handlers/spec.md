# mcp-handlers spec delta

## ADDED Requirements

### Requirement: SessionCountsAreExposedAsData

`openlore status --json` SHALL report per-session counts of changed symbols whose body changed with
an unchanged signature, whose signature changed, and whose signature could not be read (each symbol
in exactly one of the three), and of changed exported symbols, comparing each symbol's first
observed version with its latest. The system SHALL NOT compute a percentage, score, or threshold.

#### Scenario: Counts, not budgets

- **GIVEN** a session that changed the bodies of two functions and the signature of a third,
  and two of the three are exported
- **WHEN** `openlore status --json` runs
- **THEN** it reports body-only 2, signature-changed 1, exports-changed 2, and no percentage or
  threshold field

#### Scenario: A change undone is not counted

- **GIVEN** a symbol changed and then changed back in the same session
- **WHEN** the counts are read
- **THEN** the symbol is not counted
