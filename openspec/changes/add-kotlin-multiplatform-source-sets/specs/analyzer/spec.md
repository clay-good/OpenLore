# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinExpectAndActualDeclarationsAreLinked

The analyzer SHALL record the Gradle source set of each Kotlin file from its `src/<set>/` path and
SHALL derive a platform from standard Kotlin Multiplatform set names, recording `unknown` for other
names. An `expect` declaration SHALL be the binding target for its name in its package, and its
`actual` declarations SHALL NOT make that binding ambiguous. Each `actual` declaration SHALL be
joined to its `expect` declaration by an `actualizes` relation. Reachability SHALL flow from an
`expect` declaration to all of its `actual` declarations, and change impact SHALL flow from an
`actual` declaration to the callers of its `expect` declaration. An `actual` declaration SHALL NOT
be a dead-code candidate while its `expect` declaration is reachable. An `expect` and `actual` pair,
and sibling `actual` declarations, SHALL be marked as platform variants and SHALL NOT be reported as
clones. An `expect` without an `actual` and an `actual` without an `expect` SHALL be counted in a
disclosed receipt and SHALL NOT be reported as errors.

#### Scenario: A common caller reaches the platform implementations

- **GIVEN** `expect fun now(): Long` and `fun stamp() = now()` in `src/commonMain/kotlin`, and
  `actual fun now()` in `src/jvmMain/kotlin` and in `src/iosMain/kotlin`
- **WHEN** the call graph is built
- **THEN** `stamp` calls the `expect` declaration
- **AND** both `actual` declarations are reachable from `stamp`

#### Scenario: A cross-file call to an expect function binds

- **GIVEN** a file in another package that imports `com.acme.now` and calls `now()`
- **WHEN** the call graph is built
- **THEN** the call binds to the `expect` declaration and is not refused as ambiguous

#### Scenario: An actual is not dead

- **GIVEN** an `actual` function with no direct caller whose `expect` declaration has callers
- **WHEN** dead code is reported
- **THEN** the `actual` function is not a candidate

#### Scenario: Platform variants are not clones

- **GIVEN** two `actual` implementations of one `expect` function with similar bodies
- **WHEN** clones are reported
- **THEN** the pair is not listed as a clone group

#### Scenario: Changing an actual reports the expect's callers

- **GIVEN** a diff that modifies `actual fun now()` in `src/jvmMain`
- **WHEN** the blast radius is computed
- **THEN** it includes the callers of `expect fun now()`

#### Scenario: A missing platform is a receipt, not an error

- **GIVEN** an `actual` declaration whose `expect` declaration is not in the repository
- **WHEN** the repository is analyzed
- **THEN** analysis completes and the unmatched-actual count is one
