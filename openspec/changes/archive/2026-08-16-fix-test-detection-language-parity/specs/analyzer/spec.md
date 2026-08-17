# analyzer spec delta

## ADDED Requirements

### Requirement: TestFileDetectionCoversSupportedLanguages

The canonical test-file predicate (`isTestFile`) SHALL detect the conventional test-file path
patterns of every language the call-graph extractor claims (`CALLGRAPH_LANGUAGES`), including
at minimum: C# `*Test.cs`/`*Tests.cs`; Ruby `*_test.rb`, `*_spec.rb`, and the `spec/`
directory tree; PHP `*Test.php` and nested `tests/**` trees; Elixir `*_test.exs`; Dart
`*_test.dart`; Lua `spec/**/*_spec.lua`; Swift `*Test.swift`/`*Tests.swift` and the SwiftPM
`Tests/` tree; Rust `tests/**/*.rs`; and JS/TS `.mts`/`.cts` test suffixes. Directory-convention
patterns SHALL match nested paths, not only the top level. Detection SHALL remain a
deterministic path predicate with no content sniffing and no new tuning constants; known
content-level conventions a path predicate cannot see (e.g. Rust inline `#[cfg(test)]`
modules) SHALL be disclosed as a boundary, not silently claimed.

#### Scenario: A conventional test file is marked isTest across languages

- **GIVEN** a repository containing `FooTests.cs`, `spec/models/user_spec.rb`,
  `tests/Unit/FooTest.php`, `test/foo_test.exs`, `test/widget_test.dart`, and
  `Tests/AppTests/FooTests.swift`
- **WHEN** the call graph is built
- **THEN** each file's nodes carry `isTest` and its calls into production code derive
  `tested_by` edges, so `select_tests` can reach them

#### Scenario: Production files are not over-matched

- **GIVEN** production files such as `src/Contest.cs`, `lib/spectrum.rb`, and
  `src/latest.rs`
- **WHEN** `isTestFile` evaluates them
- **THEN** none is classified as a test file

#### Scenario: A new callGraph language cannot skip the test-detection decision

- **GIVEN** a language newly added to `CALLGRAPH_LANGUAGES`
- **WHEN** the conformance guard runs in CI
- **THEN** the build fails unless the language either has declared test-detection patterns or
  the registry explicitly reports `testDetection` unsupported for it

### Requirement: TestDetectionCapabilityIsRegistryDeclared

The language-support registry SHALL expose a `testDetection` capability per language, derived
from the same per-language declaration the test-file predicate owns — never hand-listed — so
the capability matrix cannot claim test detection the predicate does not implement. The
capability SHALL surface through `get_language_support` and the generated coverage table, so
an empty `select_tests` or over-reported coverage gap on a language is statically
interpretable as "unsupported here" versus "no tests found".

#### Scenario: The matrix cannot over-claim test detection

- **GIVEN** a language whose test conventions have no patterns in the shared predicate
- **WHEN** `get_language_support` reports that language
- **THEN** `testDetection` is unsupported for it, because the flag derives from the
  predicate's own declaration

#### Scenario: A quiet select_tests result becomes interpretable

- **GIVEN** a changed function in a language whose `testDetection` capability is unsupported
- **WHEN** `select_tests` returns no reaching tests
- **THEN** the registry answers "test detection is unsupported for this language" as a
  statically queryable fact, consistent with the existing `testDetection: none|partial`
  caveats in the select_tests and coverage-gaps output
