# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ExactFitTokenBudgeting

When a caller passes `tokenBudget` to `orient`, the handler SHALL fit the whole response, as it is
sent (pretty-printed JSON, including the index-staleness note and the receipt), to that budget. It
SHALL first build the answer for the top `limit` functions exactly as without a budget, with every
file-scoped section computed for that answer's files. When that answer fits, the handler SHALL add
functions ranked past `limit`, each with its call path, from a bounded pool, while the response still
fits, so a budget at least the size of the default answer with its receipt never returns less than it;
exact duplicates among added functions collapse, and a duplicate of an answer function is not added. When the answer
does not fit, the handler SHALL drop whole entries from the lowest-ranked end of its list sections, in a
fixed peripheral-first order, choosing the fewest removals that fit and keeping at least one function;
a call path SHALL be kept exactly when its function is. Governance context (pending, stale, reversed,
and governing decisions, and unreconciled memories), architecture violations, matching specs, and the
file scope SHALL never be dropped. The response SHALL carry a `budget` receipt with the budget, the
estimated tokens of the response as sent, whether it fits, the functions added past `limit`, and the
entries omitted per section. A budget that is not a finite number of at least 1 SHALL be rejected; a `null` budget means no budget.
Fitting SHALL be deterministic. When no budget is passed, output SHALL be unchanged.

#### Scenario: A budget that covers the default answer only adds

- **GIVEN** an orient call whose `tokenBudget` is larger than the default answer
- **WHEN** the handler renders the result
- **THEN** every section other than the functions, call paths, and file list equals the default answer
- **AND** functions ranked past `limit` are added while the response fits, and the receipt counts them

#### Scenario: A small budget trims peripheral sections first

- **GIVEN** an orient call whose `tokenBudget` is smaller than the default answer
- **WHEN** the handler renders the result
- **THEN** whole lowest-ranked entries are dropped, peripheral sections first, with the fewest removals
  that fit
- **AND** each kept function keeps its call path, and the receipt names the omitted count per section

#### Scenario: Governance context survives any budget

- **GIVEN** a pending decision that applies to a file in the answer
- **WHEN** orient runs with a budget too small to fit
- **THEN** the pending decision is still returned, and the receipt reports that the budget was not met

#### Scenario: No budget means no change

- **GIVEN** an orient call without `tokenBudget`
- **WHEN** the handler renders the result
- **THEN** the payload is identical to the pre-change default behavior
