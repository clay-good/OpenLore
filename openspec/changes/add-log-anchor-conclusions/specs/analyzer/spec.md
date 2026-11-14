# analyzer spec delta

## ADDED Requirements

### Requirement: LogTemplatesAreExtractedInTheExistingWalk

During Pass 1, a logging call in a closed per-language callee table, and a `throw` or `raise` of a
literal message, SHALL yield a template record (ordered constant parts, file, line, enclosing
symbol) in a sidecar index rebuilt with the owning file's facts. A message with no constant part
SHALL be counted as unmatchable for its file. A language outside the table SHALL produce no records
and no counts. Extraction SHALL add no parse pass.

#### Scenario: A template literal yields ordered constant parts

- **WHEN** Pass 1 walks a file that contains `` logger.error(`payment ${id} failed after ${n} retries`) ``
- **THEN** a template record exists with the constant parts `payment `, ` failed after `, and
  ` retries` in order, the call's file and line, and the enclosing function

#### Scenario: A dynamic message is a counted boundary

- **WHEN** extraction meets `logger.info(buildMessage(ctx))`
- **THEN** no template record is written and the file's unmatchable count increases by one
