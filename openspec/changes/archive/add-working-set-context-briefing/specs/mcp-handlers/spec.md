# mcp-handlers spec delta

## ADDED Requirements

### Requirement: WorkingSetContextBriefing

The system SHALL provide a capability that, given a configured spec-store binding and an active change,
assembles a single deterministic, conclusion-shaped structural briefing spanning the change's target
repositories. For each target the briefing SHALL surface the relevant functions, callers, insertion
points, and governing specs for the change's scope, together with the fresh, in-scope prior
decisions and constraints anchored to that code. The briefing SHALL compose existing task-scoped
orientation only, with no LLM and no new relevance model, and SHALL be a briefing, never a raw graph.

#### Scenario: A change spanning two targets is briefed

- **GIVEN** a bound store and an active change whose declared targets resolve to two indexed
  repositories
- **WHEN** the working-set context is requested for that change
- **THEN** the system returns one briefing whose items each name their target repository and symbol, and
  surface the relevant functions, callers, insertion points, and governing specs in each target

### Requirement: WorkingSetContextIsBudgetedAndAttributed

The working-set briefing SHALL be bounded by the trust-calibrated context budget, ranked by structural
relevance to the change's scope, and SHALL emit an explicit omission note when truncated rather than
silently dropping items. Every item SHALL be attributed to its target repository. In-scope anchored
intent SHALL be included with its freshness verdict; orphaned intent SHALL be withheld and drifted
intent SHALL be flagged.

#### Scenario: An over-budget working set is truncated transparently

- **GIVEN** a change whose targets would produce more context than the configured budget allows
- **WHEN** the working-set context is assembled
- **THEN** the briefing is truncated to budget, ranked by relevance, and carries an omission note stating
  what was dropped

#### Scenario: Orphaned intent is not briefed as current

- **GIVEN** an in-scope decision whose anchor has been orphaned by later edits
- **WHEN** the working-set context is assembled
- **THEN** the orphaned intent is withheld from the briefing and not presented as current
