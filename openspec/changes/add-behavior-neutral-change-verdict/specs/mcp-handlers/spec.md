# mcp-handlers spec delta

## ADDED Requirements

### Requirement: ProvenNeutralEditsAreCountedAndStated

`blast_radius` and `verify_change` SHALL report how many touched symbols are proven
behavior-neutral: symbols whose text differs from the base while their normalized content hash is
equal. The count SHALL appear in `changeGranularity.provenNeutral` with a bounded sample, and
`verify_change` SHALL carry one `info` item when the count is above zero. A symbol in a file kept
whole SHALL NOT be counted, and SHALL remain reported as not assessed. The count SHALL NOT change
which symbols are seeded or which tests are selected.

#### Scenario: A mixed diff states the neutral part

- **WHEN** a diff re-indents 30 functions and changes one operator in one of them
- **THEN** `blast_radius` seeds that one function and reports 29 proven-neutral symbols

#### Scenario: A whole diff is proven neutral

- **WHEN** `verify_change` runs on a diff of only comment and layout edits in hashed languages
- **THEN** the receipt has one `info` item that says the diff is proven behavior-neutral, with the symbol and file counts

#### Scenario: What cannot be hashed is not neutral

- **WHEN** a changed file has a parse error or its language is not hashed
- **THEN** its symbols add nothing to the count and the file is listed as not assessed

#### Scenario: String contents are behavior

- **WHEN** an edit changes only the inside of a string literal
- **THEN** the symbol is reported as changed, not as proven neutral

#### Scenario: The before-stop receipt says it once

- **WHEN** the before-stop hook runs twice in one session with the same neutral counts
- **THEN** the item is printed the first time only
