# mcp-handlers spec delta

## ADDED Requirements

### Requirement: AutoApprovedProvenanceIsAlwaysDisclosed

`recall` and `verify_claim` (`decision-current`) SHALL treat `auto-approved` decisions as
authoritative but SHALL carry their provenance (`approvedBy: autopilot`, acceptance
timestamp) in the response, so an agent citing the decision can disclose that it was
machine-accepted and unreviewed. Spec rendering of an auto-approved decision SHALL carry an
explicit "auto-accepted (unreviewed)" marker. A decision promoted by a human loses the
marker; provenance SHALL never be silently upgraded.

#### Scenario: Citing an auto-accepted decision honestly

- **GIVEN** an `auto-approved` decision governing a file the agent is changing
- **WHEN** the agent calls `verify_claim` with kind `decision-current` for it
- **THEN** the verdict is `verified` (it is the live authority) and the receipt includes
  `approvedBy: autopilot`, enabling the agent to disclose the provenance to the human
