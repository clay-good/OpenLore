# analyzer spec delta

## ADDED Requirements

### Requirement: TestRelationshipsCarryAnEvidenceClass

A relationship between a test and a production symbol SHALL carry an evidence class computed from
the test's body without running the test: `asserts-on` when an assertion argument is derived from
a call to the symbol in that test, `exercises` when the test calls the symbol and no assertion uses
a value from that call, and `reaches` when the symbol is only in the test's transitive call graph.
The order SHALL be `asserts-on` > `exercises` > `reaches`, and a relationship SHALL carry the
strongest class its evidence supports. `asserts-on` SHALL be described as "an assertion consumed
this symbol's output," never as proof of correct behavior.

#### Scenario: A direct assertion on a return value

- **WHEN** a test calls a function and asserts on the value it returned
- **THEN** the relationship is `asserts-on` and cites the assertion line

#### Scenario: A call with no consuming assertion

- **WHEN** a test calls a function for its side effect and asserts only on an unrelated value
- **THEN** the relationship is `exercises`

#### Scenario: A transitive reach

- **WHEN** a test reaches a symbol only through other functions
- **THEN** the relationship is `reaches`

#### Scenario: The strongest class wins

- **WHEN** one test asserts on a symbol and another only reaches it
- **THEN** the symbol's strongest class is `asserts-on` and both relationships stay listed

### Requirement: AssertionRecognitionIsDeclaredPerFramework

Assertion recognition SHALL be declared per test framework in the language-support registry, and
SHALL be declared supported only where a recognizer identifies the framework's assertion calls and
their asserted arguments. A relationship in an unrecognized framework SHALL be classed `reaches`
with the reason stated, and its symbol SHALL NOT be described as untested.

#### Scenario: An unsupported framework reports the gap

- **WHEN** the registry is read for a language whose test framework has no recognizer
- **THEN** `assertionRecognition` is false

#### Scenario: An unrecognized assertion is disclosed

- **WHEN** a test uses an assertion form no recognizer knows
- **THEN** the class is `reaches` and the answer says the framework's assertions were not recognized
