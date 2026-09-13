# cli spec delta

## MODIFIED Requirements

### Requirement: TokenbudgetParameterForOrientAndSearchcodeMcpTools

The orient and search_code tools SHALL accept an optional tokenBudget parameter. For search_code it
caps returned results to approximately the specified token count, retaining highest-scored items and
collapsing exact duplicates. For orient it fits the whole response to the budget, collapsing exact
duplicates among the functions it adds, as the `mcp-handlers` requirement ExactFitTokenBudgeting specifies: more ranked functions
are added while they fit, or the lowest-ranked entries are dropped.

> Decision recorded: dbe1a253
> Date: 2026-06-03

#### Scenario: A token budget caps the payload

- **WHEN** `search_code` is called with `tokenBudget`
- **THEN** the result is capped to approximately that budget, keeping highest-scored items and collapsing exact duplicates

#### Scenario: A token budget fits the orient response

- **WHEN** `orient` is called with `tokenBudget`
- **THEN** the whole response is fitted to that budget and carries a `budget` receipt
