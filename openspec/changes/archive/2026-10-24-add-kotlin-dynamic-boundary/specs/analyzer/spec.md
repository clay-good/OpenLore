# analyzer spec delta

## ADDED Requirements

### Requirement: KotlinDynamicBoundarySitesAreRecorded

The analyzer SHALL record dynamic-boundary sites in Kotlin source using the existing closed site
vocabulary: dynamic class loading and service loading as `dynamic-import`; Java and Kotlin
reflective lookups and invocations as `reflective-invoke`; Spring, Koin, and Kodein lookups as
`container-resolution`; script evaluation as `code-eval`; and dynamic proxies as
`metaprogrammed-definition`. A method whose name is common outside reflection SHALL be a site only
when the file imports the gating package or the receiver chain starts at a class literal. An
ordinary call on a function value SHALL NOT be a site. A string-literal selector SHALL be recorded
with the site. Kotlin SHALL back the `dynamicBoundary` capability only together with a conformance
fixture, and SHALL NOT back `literalReflection`; the capability note SHALL state that Kotlin
dispatch tables of callable references are ordinary edges.

#### Scenario: Kotlin reflection is a site

- **GIVEN** `val k = Class.forName(name).kotlin; k.members.first { it.name == "run" }.call()`
- **WHEN** dynamic-boundary sites are extracted
- **THEN** a `dynamic-import` site and a `reflective-invoke` site are recorded in the enclosing
  function

#### Scenario: A Java reflection call from Kotlin records its selector

- **GIVEN** `Handler::class.java.getMethod("run").invoke(h)`
- **WHEN** dynamic-boundary sites are extracted
- **THEN** a `reflective-invoke` site with selector `run` is recorded

#### Scenario: A container lookup is gated on its import

- **GIVEN** one file that imports `org.koin.core.component.inject` and declares
  `val repo: Repo by inject()`, and another file that calls `cache.get()` with no container import
- **WHEN** dynamic-boundary sites are extracted
- **THEN** the first file has one `container-resolution` site and the second has none

#### Scenario: Calling a function value is not a site

- **GIVEN** `val f: (Int) -> Int = ::twice; f.invoke(2)` in a file with no reflection import
- **WHEN** dynamic-boundary sites are extracted
- **THEN** no site is recorded

#### Scenario: A dead-code verdict near a site is qualified

- **GIVEN** a Kotlin function `run` with no callers and a `getMethod("run")` site in the repository
- **WHEN** dead code is reported
- **THEN** `run` is not reported as confidently unreachable
