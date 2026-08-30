# cli spec delta

## ADDED Requirements

### Requirement: ShardSelectionIsResolvedHonestlyOrRefused

`analyze --shard <name>` SHALL resolve each repeatable name against the detected or configured
shard list. An unrecognized name SHALL be a fatal error naming available shards and nearest
candidates; it SHALL NOT fall back to a full analyze, `root`, or an empty selection.

`--shard` without an existing graph index SHALL perform a full analysis and disclose that scoping
was not applied. `--shard` combined with `--force` SHALL perform a full rebuild and disclose that
definition. A scoped epilogue SHALL name recomputed shards, retained shards with their freshness
and last-recomputed timestamp, frontier size, explicitly stale files, and the receipt path. It
SHALL NOT describe the run as a complete repository analysis.

#### Scenario: A misspelled shard is refused, not silently widened

- **GIVEN** `--shard payments-api` where the available shards are `payments`, `api`, and `root`
- **WHEN** the command runs
- **THEN** it exits fatally with the available and nearest candidates and performs no analysis

#### Scenario: No index means a disclosed full analysis

- **GIVEN** `--shard payments` on a repository with no existing index
- **WHEN** the command runs
- **THEN** a full analysis is performed and the output states that scoping was not applied

#### Scenario: Force has one explicit meaning

- **GIVEN** an existing index and `analyze --shard payments --force`
- **WHEN** the command runs
- **THEN** it performs and reports a full rebuild rather than a partial forced extraction
