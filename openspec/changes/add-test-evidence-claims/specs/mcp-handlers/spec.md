# Spec Delta

## ADDED Requirements

### Requirement: VerifyClaimSupportsTheTestedKind

`verify_claim` SHALL support a `tested` claim kind whose subject is a symbol. The verdict SHALL be
`confirmed` only when an `asserts-on` relationship exists, citing the test file, the test name and
the assertion line; `refuted` when no test relationship of any class exists for a symbol that is
itself reachable; and `unverifiable` when the only relationships are `exercises` or `reaches`, or
when the tests' framework assertions were not recognized.

The verdict SHALL carry the same receipt discipline as the existing structural kinds: the caller
SHALL be able to cite what was checked, and an `unverifiable` verdict SHALL instruct the caller to
hedge or read the test rather than assert coverage.

#### Scenario: An assertion-backed symbol is confirmed with its citation

- **GIVEN** a symbol whose output is consumed by an assertion in a recognized framework
- **WHEN** a `tested` claim is verified for it
- **THEN** the verdict is `confirmed` and cites the test file, test name and assertion line

#### Scenario: Reachability alone is unverifiable, never confirmed

- **GIVEN** a symbol reached only transitively by its tests
- **WHEN** a `tested` claim is verified
- **THEN** the verdict is `unverifiable`, naming the relationship class that was found

#### Scenario: An unrecognized framework is unverifiable, not refuted

- **GIVEN** a symbol tested with assertions the analyzer does not recognize
- **WHEN** a `tested` claim is verified
- **THEN** the verdict is `unverifiable` and names the unrecognized framework, rather than reporting
  the symbol as untested

#### Scenario: The kind is in the closed vocabulary

- **GIVEN** the claim-kind vocabulary
- **WHEN** it is read
- **THEN** `tested` is one of its members and an unlisted kind remains a contract violation
