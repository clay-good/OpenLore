# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinExceptionFlowIsExtractedAsASoundLowerBound

The analyzer SHALL extract exception flow for Kotlin and report Kotlin as a supported
error-propagation language. A `throw` of a constructor call SHALL be a throw site of that type; a
`throw` of the parameter of the enclosing catch clause SHALL carry that clause's type; any other
thrown expression SHALL be recorded as dynamic. Calls to `require`, `requireNotNull`, `check`,
`checkNotNull`, `error`, and `TODO` SHALL be throw sites of their documented exception types unless
a project function of that name is in scope. A `@Throws` annotation SHALL produce declared throw
sites. A catch clause SHALL handle its exact type name only, with `Throwable` as catch-all, and that
limit SHALL be disclosed. A `runCatching` block SHALL handle every exception thrown inside it unless
its call chain ends in `getOrThrow`. A lambda passed to a function in a fixed list of
standard-library inline functions SHALL be analyzed as part of the enclosing body; a throw inside
any other lambda SHALL NOT be attributed to the enclosing function and SHALL be counted as a
boundary. The result SHALL disclose `finally` and resource-cleanup limits, the counts of non-null
assertions and unsafe casts, un-analyzed callees, and that coroutine cancellation and asynchronous
delivery are not modeled.

#### Scenario: A typed catch handles the exact type

- **GIVEN** `fun find(id: String) = try { repo.load(id) } catch (e: IllegalStateException) { null }`
  where `load` throws `IllegalStateException`
- **WHEN** error propagation is analyzed for `find`
- **THEN** `IllegalStateException` is listed as handled internally and not as escaping

#### Scenario: A standard-library contract call is a throw site

- **GIVEN** `fun find(id: String) { require(id.isNotBlank()) { "blank" } }`
- **WHEN** error propagation is analyzed for `find`
- **THEN** `IllegalArgumentException` escapes, with the `require` call as its origin

#### Scenario: A throw inside an inline lambda escapes

- **GIVEN** `fun all(xs: List<Int>) { xs.forEach { if (it < 0) throw IllegalArgumentException() } }`
- **WHEN** error propagation is analyzed for `all`
- **THEN** `IllegalArgumentException` escapes `all`

#### Scenario: A throw inside a stored lambda is a boundary

- **GIVEN** `fun make(): () -> Unit = { throw IllegalStateException() }`
- **WHEN** error propagation is analyzed for `make`
- **THEN** `IllegalStateException` is not listed as escaping `make`
- **AND** the boundaries count one throw inside a nested lambda

#### Scenario: runCatching handles the block

- **GIVEN** `fun safe() = runCatching { risky() }.getOrNull()` where `risky` throws `IOException`
- **WHEN** error propagation is analyzed for `safe`
- **THEN** `IOException` is handled internally

#### Scenario: Kotlin is no longer reported as unsupported

- **GIVEN** an indexed Kotlin function
- **WHEN** error propagation is requested for it
- **THEN** the result is an analysis with escapes, handled exceptions, and boundaries, not an
  unsupported-language result
