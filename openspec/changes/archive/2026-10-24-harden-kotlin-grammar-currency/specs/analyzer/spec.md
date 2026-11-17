# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinSyntaxCoverageIsMeasuredAgainstADeclaredLanguageLevel

The analyzer SHALL declare the Kotlin language version it supports and SHALL keep a syntax corpus
with one sample per language feature, each labeled with the version that made it stable. Every
stable feature up to the declared level SHALL parse without error or SHALL be listed in a
known-gaps table. A test SHALL fail when a feature is neither, and SHALL fail when a listed gap
parses without error. For each known gap, the declarations outside the error region SHALL still be
extracted with their correct owners, and the file SHALL be reported by parse-health. The syntax
coverage table in the documentation SHALL be generated from the corpus results and kept equal to
them by a guard. A change of Kotlin grammar SHALL be preceded by a recorded decision that compares
the candidates on corpus pass rate, parse-tree comparison on a real repository, runtime
compatibility, platform coverage, and supply-chain criteria.

#### Scenario: A stable feature must parse or be listed

- **GIVEN** the corpus sample for functional interfaces, a feature stable below the declared level
- **WHEN** the corpus test runs with a grammar that reports a parse error for it
- **THEN** the test passes only if functional interfaces are in the known-gaps table

#### Scenario: A stale known gap fails the test

- **GIVEN** a feature listed as a known gap
- **WHEN** the grammar in use parses its sample without error
- **THEN** the corpus test fails until the entry is removed

#### Scenario: A known gap degrades safely

- **GIVEN** a file with a known-gap construct between two ordinary functions in a class
- **WHEN** the file is analyzed
- **THEN** both functions are extracted with that class as their owner
- **AND** the file is listed in parse-health with the error line

#### Scenario: The published table matches the test

- **GIVEN** the syntax coverage table in the language-support documentation
- **WHEN** the documentation guard runs
- **THEN** every row equals the corpus result for that feature

#### Scenario: A grammar change has a decision record

- **GIVEN** a pull request that changes the Kotlin grammar dependency
- **WHEN** it is reviewed
- **THEN** a decision record with the comparison on the stated criteria exists and is referenced
