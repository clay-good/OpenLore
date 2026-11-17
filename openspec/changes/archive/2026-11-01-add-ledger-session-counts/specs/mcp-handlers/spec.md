# mcp-handlers spec delta

## ADDED Requirements

### Requirement: SessionCountsAreExposedAsData

`openlore status --json` SHALL report, for code symbols the agent's edits changed (as the after-edit
hook attributes them; withheld without that report), counts of body-only changes, signature changes,
unclassified changes (signature unreadable or possibly cut), and symbols first seen after the agent
edited them (each symbol in one), and of changed exported symbols. It SHALL NOT compute a percentage,
score, or threshold.

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
