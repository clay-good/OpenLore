# mcp-handlers spec delta

## ADDED Requirements

### Requirement: DecisionStatusTransitionsAreGuarded

Decision status changes SHALL be governed by an explicit transition table over the existing status
vocabulary (`draft`, `consolidated`, `verified`, `phantom`, `approved`, `rejected`, `synced`). A
handler SHALL NOT change a decision's status without first checking that the transition from its
current status is legal. In particular: a `rejected` decision SHALL NOT be promoted to `approved`
as a side-effect of any other operation — `sync_decisions` with an explicit `id` SHALL refuse the
promotion with an error naming the current status and the required human step; reversing a
rejection SHALL require an explicit `approve_decision` carrying human authorization, and that path
SHALL disclose that a recorded rejection is being reversed. An already-`synced` decision SHALL NOT
be re-promoted. Illegal transitions SHALL leave the store and the spec files unchanged. This
requirement governs which transitions are legal; the compare-and-swap commit discipline for legal
transitions is governed separately (`DecisionStatusPromotionIsCasChecked`,
change `harden-decision-consolidation`).

#### Scenario: sync_decisions cannot resurrect a rejected decision

- **GIVEN** a decision a human rejected via `reject_decision`
- **WHEN** `sync_decisions` is called with that decision's `id`
- **THEN** the handler returns an error naming the decision's `rejected` status and the explicit
  `approve_decision` step required to reverse it
- **AND** the decision's status is unchanged and no spec file is written

#### Scenario: approve_decision discloses a rejection reversal

- **GIVEN** a `rejected` decision with a review note
- **WHEN** `approve_decision` is called with its `id`
- **THEN** the handler refuses (or requires the explicit reversal path per the transition table),
  surfacing the prior rejection and its note so the agent presents the reversal to the human
  rather than silently overriding a recorded verdict

#### Scenario: The legal lifecycle is unchanged

- **GIVEN** a `verified` decision
- **WHEN** a human approves it via `approve_decision` and it is then synced via `sync_decisions`
- **THEN** the decision moves `verified → approved → synced` exactly as before, with no new
  friction on legal transitions
