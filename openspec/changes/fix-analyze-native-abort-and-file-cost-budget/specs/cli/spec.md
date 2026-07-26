# cli spec delta

## ADDED Requirements

### Requirement: AnalyzeFailsThroughTheNormalErrorPath

`openlore analyze` SHALL report every failure through its own error path — a rendered `[error]` line
and a non-zero exit status — rather than allowing a runtime-level abort to reach the user. Output
that identifies a failure SHALL name what failed, where, and what to do next. A run that produces no
artifacts SHALL say so explicitly rather than exiting after partial progress messages.

#### Scenario: An extraction fault is legible to the user

- **GIVEN** a repository containing a file that faults the extraction worker
- **WHEN** `openlore analyze` runs and cannot complete
- **THEN** stderr carries an `[error]` line naming the file and a remedy, the exit status is non-zero,
  and the output contains no unhandled native runtime text

#### Scenario: A partial run states what was produced

- **GIVEN** a run in which some files were excluded but artifacts were still written
- **WHEN** the command finishes
- **THEN** it reports success, the count of analyzed files, and the excluded count broken down by
  reason — so "fewer symbols than expected" is attributable rather than mysterious

### Requirement: LongRunningExtractionIsAttributable

While analyzing, the CLI SHALL make a long-running file attributable: when extraction of a single
file exceeds a disclosure threshold, the file's path SHALL be surfaced in progress output. A user
waiting on a slow run SHALL be able to identify the responsible file without attaching a debugger.

#### Scenario: The slow file is named while the run is still going

- **GIVEN** a repository containing one file whose extraction takes far longer than any other
- **WHEN** `openlore analyze` runs in a terminal
- **THEN** the progress output names that file before the run completes

#### Scenario: Machine-output modes stay clean

- **GIVEN** the same repository
- **WHEN** `openlore analyze --json` runs with stdout captured
- **THEN** the progress disclosure is written to stderr and stdout remains valid JSON
