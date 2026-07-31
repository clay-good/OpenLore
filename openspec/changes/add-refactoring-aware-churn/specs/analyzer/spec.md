# analyzer spec delta

## ADDED Requirements

### Requirement: HistorySignalsFollowSymbolIdentityChains

For a queried commit range, the system SHALL build per-symbol identity chains by applying the
symbol-identity continuity matcher pair-wise across the commits touching the involved files,
recognizing only a closed operation catalog: `rename` and `move` under the matcher's existing
verify semantics, and `extract` only when the extracted body carries clone evidence from the
duplicate detector. A disappearance the matcher cannot attribute SHALL remain `removed` — never a
guessed operation — and an ambiguous candidate set SHALL end the chain rather than bind a first
match. History-derived signals (churn joins, co-change coupling, volatility, the
surprising-change tier) SHALL aggregate over identity chains where chains exist, disclosing each
followed link, and SHALL fall back to path-exact aggregation with the break disclosed where a
chain ends. Chain construction SHALL be deterministic and carry the matcher's receipt on every
link.

#### Scenario: A renamed hub keeps its churn history

- **GIVEN** a high-fan-in file renamed two commits ago with a long prior churn history
- **WHEN** the change-significance briefing computes its churn signal over a range spanning the
  rename
- **THEN** churn aggregates across the rename via the identity chain, the followed rename is
  disclosed, and the hub is not over-flagged as surprising for reading low-churn

#### Scenario: No clone evidence, no extract claim

- **GIVEN** a range where a function disappears and a similar-purpose function appears elsewhere
  without clone-detector evidence linking their bodies
- **WHEN** chains are built
- **THEN** the pair is reported as `removed` and `added`, not `extract`

#### Scenario: Ambiguity degrades to today's behavior, disclosed

- **GIVEN** a disappearance with multiple equally plausible successors
- **WHEN** chains are built
- **THEN** the chain ends at the ambiguity, consumers use path-exact aggregation for the
  remainder, and the break is disclosed in their responses
