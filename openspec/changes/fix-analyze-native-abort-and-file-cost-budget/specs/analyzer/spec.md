# analyzer spec delta

## ADDED Requirements

### Requirement: ExtractionWorkerFaultsAreContainedNotFatal

A fault raised inside a parallel extraction worker — including one that crosses the worker boundary
as a native exception, an `uncaughtException`, an unhandled rejection, or a non-zero worker exit —
SHALL be converted into a structured per-file signal and SHALL NOT terminate the analyzer process
abnormally. The build SHALL continue over the remaining files. When the pool cannot continue at all,
the analyzer SHALL surface a JavaScript-level error identifying the file and a remedy, and exit with
a non-zero status through the normal error path — never through `abort()`.

A worker fault SHALL degrade the extraction LANE, not the file: the file SHALL be re-extracted on
the main thread — the reference implementation — and the fault disclosed on the lane, rather than
the file being recorded as failed. A fault is evidence about the thread, not about the source it was
reading, and recording it against the file would silently shrink the graph by exactly one file.

No traversal of a parsed tree SHALL be bounded by the call stack. Tree depth is not bounded by
anything the analyzer controls, and error recovery — the condition under which the parse-health
walk runs — is precisely what produces the deepest trees. A stack overflow raised while executing
inside a native binding's node accessor is not catchable as a JavaScript error and terminates the
process.

#### Scenario: A deep tree is traversed without exhausting the stack

- **GIVEN** a parsed tree far deeper than the available call stack
- **WHEN** parse health is tallied over it
- **THEN** the tally completes and reports the error regions it found

#### Scenario: A native worker fault degrades one file instead of killing the run

- **GIVEN** a repository containing one file whose extraction faults inside a worker, plus 600 files
  that extract cleanly
- **WHEN** `openlore analyze` runs with the parallel extraction pool engaged
- **THEN** the process exits 0, artifacts are written for all 601 files, and the fault is disclosed
  on the extraction lane — the faulted file having been re-extracted on the main thread

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
The bound SHALL be enforced IN-BAND, inside the parse itself, rather than by an external timer or by
terminating the thread holding the parse: a tree-sitter parse is one synchronous native call, so a
timer cannot preempt it and terminating mid-parse is what converts a slow file into a process-level
abort. A binding that cannot accept the deadline SHALL parse unbounded, as before, and SHALL NOT
fail the file.

A file exceeding the budget SHALL be abandoned, recorded with reason `budget-exceeded` and the
budget it exceeded, and SHALL NOT block completion of the run. Abandoning a file SHALL cost that
file's budget ONCE for the whole build: a later pass that would re-read the same content SHALL skip
it rather than spend the budget again. The default budget SHALL be generous enough that ordinary
source files — including large generated and vendored files — are never affected, and SHALL be
operator-overridable, including a value that disables the bound entirely. Abandoning a file SHALL be
reported, never silent: a bounded result is a lower bound and must read as one.

Abandoning a parse SHALL leave the parser fit to parse the next file. A suspended parse that is
resumed by the next file's parse would silently corrupt every subsequent file in that language,
which is a worse failure than the unbounded parse this bound replaces.

#### Scenario: A pathological file is abandoned rather than stalling the run

- **GIVEN** a 300 KB file of a repeated unterminated block-comment opener, alongside ordinary sources
- **WHEN** `openlore analyze` runs
- **THEN** the run completes, that file is recorded as `budget-exceeded` with the budget it
  exceeded, and the remaining files are analyzed normally

#### Scenario: The file after an abandoned one is unaffected

- **GIVEN** an abandoned file followed by an ordinary file in the same language
- **WHEN** extraction continues
- **THEN** the ordinary file yields its symbols in full and carries no parse-health record

#### Scenario: The record is the same on every run

- **GIVEN** a repository containing a file that exceeds the budget
- **WHEN** it is analyzed twice from the same repository state
- **THEN** the persisted parse-health record is byte-identical across the two runs

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

Every file the analyzer declines to include SHALL be recorded with a machine-readable reason — parse
failure, budget exceeded, or size cap — in the parse-health record, and every producer of that
record (the full build and the incremental watcher alike) SHALL use the same vocabulary. The reason
set SHALL name only causes that can actually occur: a cause with no code path SHALL NOT be listed.

A bare count of skipped files with no reasons SHALL NOT be the only report. Any surface that reports
on extraction health SHALL read that single record, so two surfaces cannot give contradictory
answers about the same repository. Where the analyzer excludes files BEFORE extraction — the
directory/pattern walk — the count SHALL likewise be reported by reason rather than bare.

The record SHALL be deterministic: it is persisted, and re-analyzing an unchanged repository must
reproduce it byte-for-byte, so a measured duration SHALL NOT be stored in it.

#### Scenario: The skip summary names reasons

- **GIVEN** a repository in which three files are excluded for two different reasons
- **WHEN** `openlore analyze` completes
- **THEN** the summary reports the count broken down by reason rather than a bare total

#### Scenario: Health surfaces agree

- **GIVEN** a repository in which at least one file was excluded
- **WHEN** `openlore doctor` reports extraction health for that repository
- **THEN** it reports the same excluded files and reasons the analysis recorded, and does not report
  a clean bill of health
