# mcp-handlers spec delta

## ADDED Requirements

### Requirement: DatastoreAccessSitesAreConclusionsWithDisclosedConfidence

The system SHALL provide a datastore impact conclusion that, given a table or model name, returns
the line-precise access sites that read, write, or alter it, the upstream functions that
transitively reach those sites, and the tests that reach them. Each site SHALL carry an access
class and a confidence of `resolved`, `partial`, or `unresolvable`, and column attribution SHALL
be claimed only where the column appears literally at the site — a wildcard or dynamic projection
SHALL report the column set as unknown rather than empty. The result SHALL be a sound lower bound:
query sites the extractor cannot resolve, files whose data-access library is outside the supported
pattern set, and index staleness SHALL be disclosed as boundaries, never omitted. An unrecognized
table name SHALL return an explicit not-found with candidates, never an empty result implying the
table is unused. The conclusion SHALL be computed deterministically from static extraction and the
cached graph, with no database connection, no query execution, and no LLM.

#### Scenario: A table's readers, writers, and blast radius are returned

- **GIVEN** an indexed repository where two functions read the `orders` table and one writes it
- **WHEN** the datastore impact conclusion is requested for `orders`
- **THEN** all three sites are returned with file, line, enclosing function, and access class
- **AND** functions that transitively call them are returned as the affected set, with the tests
  that reach those sites

#### Scenario: An unresolvable query is disclosed, not dropped

- **GIVEN** a function that issues a query whose table name is assembled at runtime
- **WHEN** the conclusion is requested for any table
- **THEN** that site is reported as unresolvable in the boundaries with its file and line
- **AND** the returned access set is presented as a lower bound

#### Scenario: Wildcard selection does not claim columns

- **GIVEN** a read site selecting all columns of a table
- **WHEN** the conclusion is requested for that table
- **THEN** the site is reported as a table-level read with its column set stated as unknown

#### Scenario: An unsupported data-access library is a stated gap

- **GIVEN** a repository whose queries are issued through a library outside the supported pattern
  set
- **WHEN** the conclusion is requested
- **THEN** the unscanned files are disclosed as a boundary rather than contributing a silently
  empty access set

#### Scenario: An unknown table is not reported as unused

- **GIVEN** a table name that does not appear in the schema inventory or any access site
- **WHEN** the conclusion is requested for it
- **THEN** an explicit not-found is returned with candidate names
