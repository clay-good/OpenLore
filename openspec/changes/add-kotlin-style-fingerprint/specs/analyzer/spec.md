# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinStyleFingerprintIsMeasured

The analyzer SHALL measure a style fingerprint for Kotlin on the existing closed idiom set, during
the existing syntax-tree walk: function body form (expression or block), binding (`val` or `var`),
conditional form (`if` and `when` as a value or as a statement), string form (template or
concatenation), and function naming case. The asynchronous-form idiom SHALL NOT be reported for
Kotlin. No Kotlin idiom SHALL be reported as language-enforced. Functions that cannot have a body,
backtick-named functions, functions in test files, and Gradle build scripts SHALL be excluded from
the counts they would distort. The existing evidence floor SHALL apply, and an idiom below it SHALL
report a null signal with its reason. The fingerprint SHALL be descriptive only: no score and no
lint verdict.

#### Scenario: Function body form is measured

- **GIVEN** a Kotlin region with 30 expression-body functions and 10 block-body functions
- **WHEN** the fingerprint is computed
- **THEN** `functionForm` reports expression body as dominant with ratio 0.75 and 40 samples

#### Scenario: Bodiless functions are not counted

- **GIVEN** an interface with five functions that have no body
- **WHEN** the fingerprint is computed
- **THEN** those functions add no sample to `functionForm`

#### Scenario: Test sentences do not set the naming signal

- **GIVEN** a repository whose production functions are camelCase and whose test functions use
  backtick names
- **WHEN** the fingerprint is computed
- **THEN** `functionNaming` reports camelCase and counts no backtick-named function

#### Scenario: An idiom below the floor is null

- **GIVEN** a Kotlin file with three string-building expressions
- **WHEN** the file-scope fingerprint is computed
- **THEN** `stringForm` has a null signal with reason `below_floor`

#### Scenario: A Kotlin repository has a fingerprint

- **GIVEN** an analyzed Kotlin repository
- **WHEN** the style fingerprint is requested
- **THEN** a Kotlin profile is returned, not an unavailable result
