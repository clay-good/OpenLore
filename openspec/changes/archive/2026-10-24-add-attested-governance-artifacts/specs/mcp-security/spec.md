# mcp-security spec delta

## ADDED Requirements

### Requirement: DecisionHistoryIsTamperEvident

Each decision status transition SHALL append a ledger entry carrying the hash of the prior entry
for that decision, so the full transition history replays deterministically to the current
status. `verify_claim`'s `decision-current` kind SHALL report an additive `historyIntact` field:
`true` when the chain replays, `violated` when it does not, and `not-chained` for stores written
before chaining existed — never a retroactive integrity claim. Chain verification SHALL be a
local hash replay requiring no key and no network.

#### Scenario: A silent status flip is detected

- **GIVEN** a decision whose store file was hand-edited to flip `rejected` to `approved`
  without a ledger transition
- **WHEN** `verify_claim` runs with kind `decision-current` on that decision id
- **THEN** the response includes `historyIntact: violated` alongside the status verdict, so the
  citation cannot present the tampered state as clean

#### Scenario: Legacy stores are disclosed, not accused

- **GIVEN** a decision store created before hash chaining
- **WHEN** `verify_claim decision-current` runs
- **THEN** `historyIntact` is `not-chained`, and the verdict is otherwise identical to today's
  behavior
