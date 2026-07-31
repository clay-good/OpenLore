# cli spec delta

## ADDED Requirements

### Requirement: CallGraphFreshnessWithoutTheCommitHook

The watcher (and the serve daemon) SHALL schedule a debounced background full rebuild when
the incremental stale region crosses its work budget or the repository's `.git` HEAD ref
changes (branch switch, pull), so call-graph freshness no longer depends on the post-commit
hook being installed. The rebuild rides the existing singleflight coordinator and atomic
swap; rapid successive triggers coalesce into one rebuild. The post-commit hook remains
supported as the fast path.

#### Scenario: A branch switch refreshes the graph unprompted

- **GIVEN** a repo with the watcher running and no post-commit hook installed
- **WHEN** the user switches branches, changing many files
- **THEN** one debounced background rebuild is scheduled, reads during it disclose
  staleness with the repair marker, and the graph converges without any manual command

### Requirement: DoctorCanApplyItsOwnRemediations

`openlore doctor --fix` SHALL execute exactly the remediations the corresponding read-only
checks print (re-running analysis, re-wiring a detected mis-wire via the install engine) —
nothing a check did not surface. In a TTY each mutating fix asks one confirmation;
`--yes` runs non-interactively. Bare `openlore doctor` SHALL remain read-only and
byte-compatible with its current output contract.

#### Scenario: One command from diagnosed to healthy

- **GIVEN** a repo where doctor reports a stale analysis and the legacy settings mis-wire
- **WHEN** the user runs `openlore doctor --fix --yes`
- **THEN** analysis is rebuilt and the wiring corrected, a re-run of `doctor` passes, and
  no other state was touched
