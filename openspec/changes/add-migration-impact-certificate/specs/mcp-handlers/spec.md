# mcp-handlers spec delta

## ADDED Requirements

### Requirement: MigrationImpactIsCertifiedAgainstTheGraph

The system SHALL provide an opt-in `certify_migration` conclusion tool that classifies each
statement of the changed schema migrations — and each field removed or narrowed in a supported
ORM model diff — against a closed, registered rule table into `destructive`, `lock-hazardous`,
or `safe-shape`, and joins every destructive or narrowing target to the code: the schema
inventory entry, the indexed functions still referencing the target (with file and line), their
upstream blast radius, and the reaching tests. A statement the scanner cannot classify SHALL be
reported `unassessed` with its count — never implicitly safe. The reference join SHALL be
labeled a name-based sound lower bound: an empty join reads "no reference found in the index",
never "unreferenced". Each rule SHALL be a registered governance finding code, advisory by
default and classifiable by the operator's enforcement policy. The tool SHALL cross-reference
`get_schema_inventory` as the inventory it concludes over and `analyze_env_impact` as the same
conclusion shape for configuration.

#### Scenario: A dropped column names its surviving readers

- **GIVEN** a migration dropping a column that three indexed functions still reference
- **WHEN** `certify_migration` runs
- **THEN** the certificate reports a destructive finding naming the three functions with file
  and line, their blast radius, and the reaching tests to run

#### Scenario: The ORM path reaches the same conclusion

- **GIVEN** a supported ORM model diff removing a field referenced in code
- **WHEN** the certificate is computed
- **THEN** the removed field yields the same destructive finding and code join

#### Scenario: Lock hazards are classified by rule, not judgment

- **GIVEN** a migration creating an index non-concurrently on an existing table
- **WHEN** the certificate is computed
- **THEN** the statement is `lock-hazardous` with its rule code, and the concurrent form of the
  same statement is `safe-shape`

#### Scenario: The unparsed is disclosed, and absence is a lower bound

- **GIVEN** a migration containing a dialect construct the scanner does not recognize, and a
  dropped column with no indexed reference
- **WHEN** the certificate is computed
- **THEN** the unrecognized statement is reported `unassessed`, and the empty join is reported
  as "no reference found in the index", not "unreferenced"
