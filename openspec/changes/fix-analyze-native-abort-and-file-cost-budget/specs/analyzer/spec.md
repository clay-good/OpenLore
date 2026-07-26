# analyzer spec delta

## ADDED Requirements

### Requirement: ExtractionWorkerFaultsAreContainedNotFatal

A fault raised inside a parallel extraction worker — including one that crosses the worker boundary
as a native exception, an `uncaughtException`, an unhandled rejection, or a non-zero worker exit —
SHALL be converted into a structured per-file extraction failure and SHALL NOT terminate the
analyzer process abnormally. The build SHALL continue over the remaining files, recording the
faulting file as failed with its path and the fault's message. When the pool cannot continue at all,
the analyzer SHALL surface a JavaScript-level error identifying the file and a remedy, and exit with
a non-zero status through the normal error path — never through `abort()`.

#### Scenario: A native worker fault degrades one file instead of killing the run

- **GIVEN** a repository containing one file whose extraction raises a `Napi::Error` inside a worker,
  plus 600 files that extract cleanly
- **WHEN** `openlore analyze` runs with the parallel extraction pool engaged
- **THEN** the process exits 0, artifacts are written for the 600 clean files, and the faulting file
  is recorded as a failed extraction naming the file and the fault

#### Scenario: A fatal pool failure is reported, not aborted

- **GIVEN** an extraction pool that cannot continue after a worker fault
- **WHEN** `openlore analyze` runs
- **THEN** it prints an `[error]` line naming the file and the remedy and exits non-zero
- **AND** the output contains no native runtime abort text and the exit status is not 134

#### Scenario: Worker faults never corrupt the artifact set

- **GIVEN** a run in which one of several workers faults mid-extraction
- **WHEN** the analyzer writes its artifacts
- **THEN** the artifacts describe exactly the files that extracted successfully, and the failed file
  is absent from the graph and present in the parse-health record — never half-written into both

### Requirement: PerFileExtractionCostIsBounded

Extraction of a single file SHALL be bounded by a wall-clock budget expressed as a named constant.
A file exceeding the budget SHALL be abandoned, recorded with reason `budget-exceeded` and its
elapsed time, and SHALL NOT block completion of the run. The default budget SHALL be generous enough
that ordinary source files — including large generated and vendored files — are never affected, and
SHALL be operator-overridable. Abandoning a file SHALL be reported, never silent: a bounded result is
a lower bound and must read as one.

#### Scenario: A pathological file is abandoned rather than stalling the run

- **GIVEN** a 300 KB file of a repeated unterminated block-comment opener, alongside ordinary sources
- **WHEN** `openlore analyze` runs
- **THEN** the run completes, that file is recorded as `budget-exceeded` with its elapsed time, and
  the remaining files are analyzed normally

#### Scenario: Ordinary large files are unaffected

- **GIVEN** a repository containing a 1.5 MB generated client and a large minified vendor bundle that
  extract within the budget
- **WHEN** `openlore analyze` runs
- **THEN** no file is recorded as `budget-exceeded` and the graph is identical to a run with the
  budget disabled

#### Scenario: A conclusion over an abandoned file discloses the boundary

- **GIVEN** an analysis in which one file was abandoned for exceeding the budget
- **WHEN** a conclusion tool returns a result whose reachable set touches that file
- **THEN** the response discloses that symbols and edges from that file are a lower bound

### Requirement: EveryExcludedFileIsRecordedWithAReason

Every file the analyzer declines to include SHALL be recorded with a machine-readable reason — size
cap, encoding, parse failure, worker fault, or budget exceeded — in the parse-health record. A bare
count of skipped files with no reasons SHALL NOT be the only report. Any surface that reports on
extraction health SHALL read that single record, so two surfaces cannot give contradictory answers
about the same repository.

#### Scenario: The skip summary names reasons

- **GIVEN** a repository in which three files are excluded for two different reasons
- **WHEN** `openlore analyze` completes
- **THEN** the summary reports the count broken down by reason rather than a bare total

#### Scenario: Health surfaces agree

- **GIVEN** a repository in which at least one file was excluded
- **WHEN** `openlore doctor` reports extraction health for that repository
- **THEN** it reports the same excluded files and reasons the analysis recorded, and does not report
  a clean bill of health
