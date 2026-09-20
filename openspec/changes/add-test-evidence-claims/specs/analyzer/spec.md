# Spec Delta

## ADDED Requirements

### Requirement: TestRelationshipsCarryAnEvidenceClass

A recorded relationship between a test and a production symbol SHALL carry an evidence class derived
statically from the test's body: `asserts-on` when an assertion's argument is derived from a call to
the symbol within that test, `exercises` when the test calls the symbol but no assertion consumes a
value derived from that call, and `reaches` when the symbol appears only in the test's transitive
call graph. The class SHALL be computed without executing the test, without coverage
instrumentation, and without mutation.

The classes SHALL be ordered `asserts-on` > `exercises` > `reaches`, and a relationship SHALL carry
the strongest class its evidence supports.

#### Scenario: A direct assertion on a return value is asserts-on

- **GIVEN** a test calling a function and asserting on the value it returned
- **WHEN** the repository is analyzed
- **THEN** the relationship is classed `asserts-on`, citing the assertion's line

#### Scenario: A call with no consuming assertion is exercises

- **GIVEN** a test that calls a function for its side effect and asserts only on an unrelated value
- **WHEN** the repository is analyzed
- **THEN** the relationship is classed `exercises`

#### Scenario: A transitive reach is reaches

- **GIVEN** a test whose call graph reaches a symbol through intermediate functions, with no direct
  call in the test body
- **WHEN** the repository is analyzed
- **THEN** the relationship is classed `reaches`

#### Scenario: The strongest class wins

- **GIVEN** a symbol with one test asserting on it and another merely reaching it
- **WHEN** the symbol's test evidence is reported
- **THEN** the strongest class is `asserts-on`, and both relationships remain listed with their own
  classes

### Requirement: EvidenceClassesAreASoundLowerBoundNotAGuaranteeOfCorrectness

The evidence class SHALL be presented as a lower bound on verification, never as proof that a
symbol's behavior is correct or fully specified. `asserts-on` SHALL be described as "an assertion
consumed this symbol's output", not as "this symbol is tested". A symbol with no `asserts-on`
relationship SHALL NOT be described as untested when the analysis could not recognize its test
framework's assertions.

#### Scenario: The strongest class is described honestly

- **GIVEN** a symbol whose only evidence is `asserts-on`
- **WHEN** the evidence is reported
- **THEN** the wording states that an assertion consumed the symbol's output, and does not claim
  behavioral correctness

#### Scenario: An unrecognized framework is disclosed, not downgraded silently

- **GIVEN** a test written with an assertion form the analyzer does not recognize
- **WHEN** its relationship is classified
- **THEN** the class is `reaches` and the response discloses that the framework's assertions were
  not recognized

#### Scenario: Absence of evidence is not evidence of absence

- **GIVEN** a symbol with no `asserts-on` relationship
- **WHEN** its test evidence is reported
- **THEN** the report states that no assertion was found to consume its output, and does not state
  that the symbol is untested

### Requirement: AssertionRecognitionIsDeclaredPerFramework

Assertion recognition SHALL be declared per test framework and language, so an unrecognized
framework's results are interpretable. A framework SHALL be declared supported only where an
implemented recognizer identifies its assertion call sites and their argument positions.

#### Scenario: Supported frameworks are enumerable

- **GIVEN** a repository using a supported framework
- **WHEN** the capability matrix is queried
- **THEN** assertion recognition is reported supported for that framework

#### Scenario: An unsupported framework reports the gap

- **GIVEN** a repository whose tests use an unsupported framework
- **WHEN** the capability matrix is queried
- **THEN** assertion recognition is reported unsupported, so a uniform `reaches` result is
  interpretable as a gap rather than as weak testing
