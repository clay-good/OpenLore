## ADDED Requirements

### Requirement: DecisionStatusReportsDispositionAndReason

`openlore decisions` SHALL report, for a draft id, its terminal disposition and stable reason code, or an explicit pending state when consolidation has not yet run. A decided draft SHALL never render as absent or unknown.

Where the disposition is `rejected`, the output SHALL name the reason and the concrete next action (for example: add the missing evidence, or record the decision with a narrower subject).

#### Scenario: A rejected draft is explainable from the CLI

- **GIVEN** a draft rejected with reason `no-supporting-diff`
- **WHEN** the user asks for its status by id
- **THEN** the output states `rejected`, the reason, and what to do next

#### Scenario: Pending is distinguishable from decided

- **GIVEN** a draft recorded while background consolidation has not completed
- **WHEN** the user asks for its status
- **THEN** the output states an explicit pending state, never a rejection
