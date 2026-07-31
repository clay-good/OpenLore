# analyzer spec delta

## ADDED Requirements

### Requirement: LogTemplatesAreExtractedInTheExistingWalk

During Pass 1, call sites matching a closed, source-declared per-language logger pattern table
whose arguments contain string or template literals SHALL yield template records (ordered
constant parts, file, line, enclosing symbol) persisted in an incrementally-maintained sidecar
index. A logging call whose message is fully dynamic (no extractable constant part) SHALL be
counted as an unmatchable boundary for its file — never silently dropped. Languages outside the
pattern table SHALL produce no counters and no records (fail-soft), and extraction SHALL add no
parse pass: templates are read from trees the walk already visits.

#### Scenario: A template literal yields ordered constant parts

- **GIVEN** a call `logger.error(\`payment ${id} failed after ${n} retries\`)`
- **WHEN** Pass 1 walks the file
- **THEN** a template record exists with constant parts ["payment ", " failed after ",
  " retries"] in order, the call's file and line, and the enclosing function

#### Scenario: Dynamic messages are a counted boundary

- **GIVEN** a call `logger.info(buildMessage(ctx))`
- **WHEN** extraction runs
- **THEN** no template record is emitted and the file's unmatchable-boundary count increases
  by one
