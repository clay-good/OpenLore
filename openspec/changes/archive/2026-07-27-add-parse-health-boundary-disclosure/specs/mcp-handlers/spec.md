# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ConclusionsDiscloseParseHealthBoundaries

A conclusion tool whose result depends on extraction from a file with a degraded parse-health
record (ERROR/MISSING regions, parse failure, or encoding fallback) SHALL append a boundary
disclosure identifying the file and the degradation, so a smaller-than-real result reads as a lower
bound rather than verified absence. `get_language_support`, `orient`, and `doctor` SHALL surface a
compact parse-health summary (per-language counts / degraded-file lists) for the analyzed scope. A
repository with no degraded files SHALL incur no boundary output and no payload growth. Parse-health
regressions SHALL be expressible as the registered governance finding `parse-health` (advisory by
default; enforcement class owned by the operator's `enforcement.policy`).

#### Scenario: Dead-code over a degraded file carries a boundary

- **GIVEN** `find_dead_code` whose reachability set touches a file that parsed with ERROR regions
- **WHEN** the tool returns candidates
- **THEN** the response disclosed that symbols and edges in that file are a lower bound

#### Scenario: Clean repositories pay nothing

- **GIVEN** a repository whose files all parse cleanly
- **WHEN** any conclusion tool runs
- **THEN** no parse-health boundary appears and response size is unchanged

#### Scenario: An operator gates on parse-health regressions

- **GIVEN** an `enforcement.policy` classing `parse-health` as `blocking`
- **WHEN** `openlore enforce` runs after a grammar upgrade that degraded 40 files
- **THEN** the gate blocks with the finding's evidence (file counts, spans)
