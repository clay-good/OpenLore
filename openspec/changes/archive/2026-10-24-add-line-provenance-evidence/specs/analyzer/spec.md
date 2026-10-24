# analyzer spec delta

## ADDED Requirements

### Requirement: AuthorshipFactsAreIngestedNeverInferred

When line-attribution records (git notes ref or repo sidecar files in the vendor-neutral
attribution format) are present, `analyze` SHALL project their line ranges onto persisted symbol
spans and record a per-symbol authorship fact (`human | agent | mixed | unknown`, with covered
and total line counts). Authorship SHALL NEVER be inferred from commit trailers, author
identities, or content heuristics: a symbol with no covering record is `unknown`, a malformed
record is skipped with a counted disclosure, and an unmappable range (e.g. after a history
rewrite) degrades the affected symbol to `unknown`. Absent records SHALL produce no behavior
change anywhere.

#### Scenario: Records project onto symbols

- **GIVEN** a repository whose attribution records cover every line of function `f` with agent
  attribution and half the lines of function `g` with human attribution
- **WHEN** `analyze` runs
- **THEN** `f`'s authorship fact is `agent` with full coverage, `g`'s is `human` with partial
  coverage disclosed (`coveredLines < totalLines`), and every unrecorded symbol is `unknown`

#### Scenario: No records means no change

- **GIVEN** a repository with no attribution records
- **WHEN** `analyze` runs
- **THEN** no authorship sidecar is written and all conclusions are byte-identical to the
  pre-change behavior
