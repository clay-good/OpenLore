# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ExactFitTokenBudgeting

When a caller passes `tokenBudget` to `orient`, the handler SHALL fit the whole rendered payload to
that budget, not a single section over a fixed candidate cap. It SHALL trim whole entries from the
lowest-ranked end of its list sections, in a fixed peripheral-first order, and find the fewest removals
that fit, keeping at least one relevant function; a call path SHALL be kept exactly when its function
is. When the budget allows, relevant functions and call
paths SHALL be drawn from a bounded pool larger than the default entry cap. Governance context
(pending, stale, reversed, and governing decisions, and unreconciled memories) SHALL never be trimmed.
The payload SHALL carry a `budget` receipt stating the budget, the estimated tokens, whether it fits,
and the entries omitted per section. Fitting SHALL be deterministic (same graph, task, and budget
yield the same payload). When no budget is passed, output SHALL be unchanged from the pre-existing
behavior.

#### Scenario: A small budget yields a fitted payload with receipts

- **GIVEN** an orient call with a `tokenBudget` smaller than the default payload
- **WHEN** the handler renders the result
- **THEN** the estimated tokens of the rendered payload are within the budget
- **AND** entries were dropped whole from the lowest-ranked end, peripheral sections first
- **AND** the `budget` receipt names the omitted count per section

#### Scenario: A large budget broadens beyond the entry cap

- **GIVEN** an orient call with a `tokenBudget` larger than the default payload
- **WHEN** the handler renders the result
- **THEN** more relevant functions are included than the `limit` entry cap, up to the bounded pool

#### Scenario: Governance context survives any budget

- **GIVEN** a pending decision that applies to a relevant file
- **WHEN** orient runs with a budget too small to fit
- **THEN** the pending decision is still returned, and the receipt reports that the budget was not met

#### Scenario: No budget means no change

- **GIVEN** an orient call without `tokenBudget`
- **WHEN** the handler renders the result
- **THEN** the payload is identical to the pre-change default behavior
