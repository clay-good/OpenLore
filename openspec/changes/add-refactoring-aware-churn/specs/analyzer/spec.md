# analyzer spec delta

## ADDED Requirements

### Requirement: HistorySignalsFollowSymbolIdentityChains

For the files a history query touches, the system SHALL build per-symbol identity chains by
applying the continuity matcher pair-wise across the commits that touch those files, recognizing
only `rename` and `move`. An ambiguous candidate set SHALL end the chain. Churn, co-change coupling
and the surprising-change tier SHALL aggregate over chains where they exist and disclose each
followed link, and SHALL fall back to path-exact aggregation with the break disclosed where a
chain ends.

#### Scenario: A renamed hub keeps its churn history

- **WHEN** the change-significance briefing covers a range in which a high-fan-in file with long prior churn was renamed
- **THEN** churn aggregates across the rename, the followed rename is disclosed, and the hub is not flagged surprising for reading low-churn

#### Scenario: An unmatched removal is not guessed

- **WHEN** a function disappears and the matcher finds no verified successor
- **THEN** the function is reported as removed and no chain link is created

#### Scenario: Ambiguity falls back to today's behavior

- **WHEN** a disappeared symbol has several equally plausible successors
- **THEN** the chain ends there, consumers use path-exact aggregation for the rest, and the break is disclosed
