# project spec delta

## ADDED Requirements

### Requirement: PerformanceBudgetsAreCounterBasedAndDeterministic

The project SHALL guard against performance regressions with counter-based budgets — counts of
deterministic work units (files parsed, queries compiled, node-table loads, adjacency
rebuilds, type inferences, SQL statements, bytes written) on a pinned fixture — asserted in
CI-visible tests, not wall-clock timings. Budgets over deterministic counters SHALL be exact;
a change that legitimately raises a budget SHALL update its recorded baseline in the same
change with the measured delta stated.

#### Scenario: A reintroduced redundant pass fails CI

- **GIVEN** the counter-based budget suite on the pinned fixture
- **WHEN** a change reintroduces a redundant corpus parse pass or a per-call full-graph rebuild
- **THEN** a budget assertion fails, rather than the regression landing silently

#### Scenario: Budgets are deterministic, not flaky

- **GIVEN** the budget suite run repeatedly on the same fixture
- **WHEN** the same analysis and serving work is measured again
- **THEN** the measured counts are identical across runs (no wall-clock dependence), so the
  budgets can be exact
