# mcp-handlers spec delta

## ADDED Requirements

### Requirement: BlastRadiusNamesDatastoreAccessWithDisclosedConfidence

`blast_radius` SHALL report, in a `datastoreAccess` field, the tables and columns that each changed
function reads or writes, each site with file, line, access class (`read`, `write`, `ddl`) and
confidence (`resolved`, `partial`, `unresolvable`). Sites it cannot resolve and files it cannot
scan SHALL be counted and located in `datastoreNotAssessed`. The facts SHALL come from static
extraction only, and no new tool SHALL be added for this answer.

#### Scenario: A changed writer names its table

- **WHEN** the diff edits a function that writes the `orders` table through a supported ORM
- **THEN** `blast_radius` lists `orders` under `datastoreAccess` for that function with file, line and access class `write`

#### Scenario: A query built at run time is disclosed

- **WHEN** a changed function issues a query whose table name is assembled at run time
- **THEN** the site appears in `datastoreNotAssessed` with its file and line
- **AND** the answer does not state that the function touches no table

#### Scenario: Wildcard selection does not claim columns

- **WHEN** a read site selects all columns of a table
- **THEN** the site is reported as a table-level read with its columns stated as unknown

### Requirement: VerifyChangeReportsMigrationTargetsStillInUse

When the diff drops or narrows a table or column, in a raw SQL migration file or a supported ORM
model, `verify_change` SHALL emit the advisory finding `migration-target-still-used` for each
target that still has an access site, naming the functions with file and line and the reaching
tests. The join is a name-based lower bound: a target with no site SHALL read "no reference found
in the index", never "unreferenced".

#### Scenario: A dropped column names its surviving readers

- **WHEN** a migration in the diff drops a column that three indexed functions still read
- **THEN** `verify_change` reports one `migration-target-still-used` finding that names the three functions with file and line and the reaching tests

#### Scenario: The ORM path reaches the same conclusion

- **WHEN** the diff removes a field from a supported ORM model and code still reads that field
- **THEN** the same finding is reported for the removed field

#### Scenario: An unreadable statement is not safe

- **WHEN** a migration contains a statement the scanner does not recognize
- **THEN** the statement is counted in `datastoreNotAssessed`
- **AND** no claim is made that the migration is safe
