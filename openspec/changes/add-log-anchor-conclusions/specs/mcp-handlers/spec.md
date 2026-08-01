# mcp-handlers spec delta

## ADDED Requirements

### Requirement: LogOriginIsAConclusionWithDisclosedAmbiguity

`locate_log_origin` SHALL match a caller-supplied log line against the template index by
ordered constant-part containment, returning every surviving candidate — never a guessed
narrowing — ordered by total matched constant length, each with its call site (file:line),
enclosing function, backward call paths, and reaching tests. A zero-candidate response SHALL
include the repository's unmatchable-boundary count and, where applicable, that matching
templates exist only in unsupported languages. Every response SHALL state its basis — static
templates at the current index, which may lag the deployed version — and carry the standard
staleness disclosure when the index trails the working tree. The tool SHALL be a `conclusion`
in family `navigate`, available only in the `full` preset, and SHALL involve no log ingestion,
tailing, or runtime integration of any kind.

#### Scenario: An interpolated production line resolves to its emitter

- **GIVEN** the indexed template for `payment ${id} failed after ${n} retries` and the query
  line `payment 84c2 failed after 3 retries`
- **WHEN** `locate_log_origin` runs
- **THEN** the emitting call site is returned with file:line, enclosing function, backward
  paths, and reaching tests, with the static-basis statement present

#### Scenario: Ambiguity is returned whole

- **GIVEN** two templates whose constant parts both survive containment for the queried line
- **WHEN** the match runs
- **THEN** both candidates are returned ordered by matched constant length with the ambiguity
  reason stated, and the response never selects one silently
