# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ConclusionsDiscloseWhenTheIndexIsBehindTheWorkingTree

Before serving, the cold-navigation conclusion handlers `orient`, `search_code`, `get_subgraph`,
and `blast_radius` SHALL compare the bounded set of source files cited by their final payload —
and only those files — against the analysis artifact's recorded baseline (modification time
first, content hash to confirm, reusing the span-locator's dual-baseline mechanic through a
shared helper). When any checked file has changed since the baseline, the payload SHALL carry a
factual staleness note naming the changed files and stating that results may omit recent edits.
If a payload contains more citations than the bounded check can inspect, it SHALL instead carry
an explicit unchecked-citations boundary and SHALL NOT imply the omitted citations are current.
The conclusion SHALL still be served (fail-open); the check SHALL NOT scan beyond the cited
files; a repository where every cited file was checked and matches the baseline SHALL produce
no note and no per-call cost beyond the bounded stat/hash of cited files.

#### Scenario: A cold-started server serves a stale graph with disclosure

- **GIVEN** a repository analyzed at commit X, then edited on disk (a new function appended to
  `src/payments.ts`) with no re-analyze
- **WHEN** a freshly started MCP server receives `orient` for a task matching that file
- **THEN** the payload includes a staleness note naming `src/payments.ts`, and the structural
  results are otherwise served as today

#### Scenario: A fresh index stays silent

- **GIVEN** a repository whose working tree matches the analysis baseline
- **WHEN** any of the four cold-navigation conclusion tools runs
- **THEN** no staleness note appears in the payload

### Requirement: DetectedColdStalenessFeedsTheRepairPathWhereOneIsWired

When a read-time staleness detection occurs in a host that has a repair path (an in-process
watcher under `--watch-auto`, or a serve daemon), the changed files SHALL be handed to the
existing stale-region/self-rebuild machinery, and the staleness note SHALL state that repair has
been scheduled. In a host with no repair path (a one-shot CLI invocation), the note SHALL
disclose only; it SHALL NOT spawn analysis work from a read.

#### Scenario: Watcher-hosted detection schedules repair

- **GIVEN** the cold-started server above running with `--watch-auto`
- **WHEN** the stale read is detected
- **THEN** the note states repair is scheduled, and a subsequent orient after convergence
  reflects the edit with no staleness note
