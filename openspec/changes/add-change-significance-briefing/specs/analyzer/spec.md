# analyzer spec delta

## ADDED Requirements

### Requirement: ChangeSignificanceLabeling

Given a base ref and the current indexed state, the system SHALL compute the changed symbols between
them and SHALL label each with a fixed, closed set of significance labels produced by classifiers the
system already has — NOT by a new weighted score and NOT with any new tuning constant. The labels and
their tier order SHALL be: `surprising-change` (the symbol is a hub by the existing fan-in classifier
AND has low historical churn by the existing change/churn signal) > `hub-change` (a high-fan-in symbol
changed) > `chokepoint-change` (a betweenness chokepoint changed) > `ordinary-change`. Within a tier,
ordering SHALL be by raw fan-in (evidence, not a constant). Each labeled symbol SHALL carry the raw
evidence behind its labels (fan-in count, prior churn), so the ranking is transparent. The labeling
SHALL be a pure function of the two indexed states and git history — byte-identical for a fixed ref
pair.

#### Scenario: A stable hub that changed ranks highest

- **GIVEN** a change set in which one high-fan-in function that had rarely changed before is modified
  amid many trivial leaf changes
- **WHEN** significance labels are computed
- **THEN** the modified hub is labeled `surprising-change` and ranks above the trivial changes, carrying
  its fan-in count and prior-churn evidence

#### Scenario: The surprising-change label is withheld without churn history

- **GIVEN** a repository whose git history is too shallow to establish that a changed hub rarely changed
  before
- **WHEN** significance labels are computed
- **THEN** the changed hub is labeled `hub-change`, not `surprising-change`, because the surprise signal
  lacks the evidence to support it

#### Scenario: Labeling is deterministic

- **GIVEN** the same repository and the same base ref
- **WHEN** significance labels are computed twice
- **THEN** the labels, tiers, and ordering are byte-identical
