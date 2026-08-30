# config spec delta

## ADDED Requirements

### Requirement: WorkspaceShardOverridesAreBoundedAndUnambiguous

The optional `workspace.shards` configuration SHALL replace manifest detection with named,
repository-relative shard roots. Names and normalized roots SHALL be non-empty and unique, the
implicit `root` name SHALL be reserved, and configured or detected declarations SHALL be bounded.
Invalid configuration SHALL be refused rather than silently renamed or widened.

#### Scenario: Duplicate configured names are refused

- **GIVEN** two configured shards with the same name
- **WHEN** configuration is validated
- **THEN** validation reports a fatal finding naming the duplicate field

#### Scenario: Repository-owned declarations are bounded

- **GIVEN** a manifest or configuration exceeds the workspace pattern or shard limit
- **WHEN** shards are detected
- **THEN** analysis stops with a bounded error before performing unbounded glob expansion
