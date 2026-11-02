/**
 * Canonical test-file predicate shared by the call-graph builder and the
 * artifact generator. These two must agree: the artifact generator excludes
 * test files from signature extraction and the production edge store, while the
 * call-graph builder marks their nodes `isTest` and derives `tested_by` edges.
 * When the two definitions diverged, test code using directory conventions
 * (tests/, __tests__/) or *Spec.kt/*Test.scala leaked into the production graph
 * (polluting hubs/entry-points/stats) and `tested_by` edges were silently lost.
 *
 * Covers, by language:
 *   JS/TS:        foo.test.ts, foo.spec.tsx, foo.test.mts, __tests__/foo.ts
 *   Python:       test_foo.py, foo_test.py
 *   Go:           foo_test.go
 *   C/C++:        foo_test.c, foo_test.cpp, tests/unit/foo.cc
 *   C#:           FooTest.cs, FooTests.cs
 *   Ruby:         foo_test.rb, foo_spec.rb, spec/models/foo.rb
 *   PHP:          FooTest.php, tests/Unit/Foo.php
 *   Java/Kotlin:  FooTest.java, FooTests.java, FooIT.java, FooSpec.kt,
 *                 and the Maven/Gradle src/test/ source tree
 *   Scala:        FooTest.scala, FooSpec.scala
 *   Elixir/Dart:  foo_test.exs, foo_test.dart
 *   Lua:          spec/unit/foo_spec.lua
 *   Swift:        FooTest.swift, FooTests.swift, Tests/AppTests/Foo.swift
 *   Rust/Bash:    tests/integration.rs, src/auth/tests.rs, foo_test.rs, tests/unit/helper.sh
 *
 * This remains a path-only predicate. Rust's inline `#[cfg(test)] mod tests` — the language's
 * DOMINANT convention — is outside what any path can show, so it is detected separately from the
 * attribute on each test function (`rust-test-attributes.ts`) and applied beside this predicate.
 * A caller that consults this predicate alone must not describe its answer as complete for Rust;
 * {@link TEST_DETECTION_CAVEATS} names what it cannot see.
 * (change: fix-test-detection-language-parity, fix-rust-test-detection)
 */
interface TestPathRule {
  languages: readonly string[];
  pattern: RegExp;
}

const TEST_PATH_RULES: readonly TestPathRule[] = [
  { languages: ['TypeScript', 'JavaScript'], pattern: /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/ },
  { languages: ['TypeScript', 'JavaScript'], pattern: /(^|\/)__tests__\// },
  { languages: ['TypeScript', 'JavaScript', 'Python'], pattern: /(^|\/)test_[^/]+\.(ts|js|py)$/ },
  { languages: ['Python', 'Go', 'C++', 'C', 'Ruby', 'Elixir', 'Dart', 'Rust'], pattern: /[^/]+_test\.(py|go|cpp|cc|cxx|c|rb|exs|dart|rs)$/ },
  // Rust's sibling-file convention: `src/<module>/tests.rs`, declared from the module with
  // `#[cfg(test)] mod tests;`. A directory rule alone missed it (change: fix-rust-test-detection).
  { languages: ['Rust'], pattern: /(^|\/)tests\.rs$/ },
  { languages: ['Ruby', 'Lua'], pattern: /[^/]+_spec\.(rb|lua)$/ },
  { languages: ['Ruby'], pattern: /(^|\/)spec\/.*\.rb$/ },
  { languages: ['Python', 'TypeScript', 'JavaScript', 'Ruby', 'PHP', 'C++', 'C', 'Rust', 'Bash'], pattern: /(^|\/)tests?\/.*\.(py|ts|tsx|js|jsx|mjs|cjs|mts|cts|rb|php|cpp|cc|cxx|c|rs|sh)$/ },
  { languages: ['C#'], pattern: /(^|\/)[^/]+Tests?\.cs$/ },
  { languages: ['PHP'], pattern: /(^|\/)[^/]+Test\.php$/ },
  { languages: ['Java', 'Kotlin', 'Scala'], pattern: /[A-Z][a-zA-Z0-9]*(Test|Tests|IT)\.(java|kt|scala)$/ },
  { languages: ['Kotlin', 'Scala'], pattern: /[A-Z][a-zA-Z0-9]*Spec\.(kt|scala)$/ },
  { languages: ['Java', 'Kotlin', 'Scala'], pattern: /(^|\/)src\/test\/.*\.(java|kt|scala|groovy)$/ },
  { languages: ['Elixir', 'Dart'], pattern: /(^|\/)test\/.*_test\.(exs|dart)$/ },
  { languages: ['Lua'], pattern: /(^|\/)spec\/.*_spec\.lua$/ },
  { languages: ['Swift'], pattern: /(^|\/)[^/]+Tests?\.swift$/ },
  { languages: ['Swift'], pattern: /(^|\/)Tests\/.*\.swift$/ },
] as const;

/** Languages with path conventions implemented by {@link isTestFile}. */
export const TEST_DETECTION_LANGUAGES: ReadonlySet<string> = new Set(
  TEST_PATH_RULES.flatMap(rule => rule.languages),
);

/**
 * Explicit decisions for call-graph languages whose conventional tests cannot
 * be recognized from a path alone. Empty today because every current language
 * has at least one supported path convention; a future language must be added
 * here or to {@link TEST_PATH_RULES} before the parity guard will pass.
 */
const TEST_DETECTION_UNSUPPORTED_LANGUAGES: ReadonlySet<string> = new Set();

export type TestDetectionDecision = 'supported' | 'unsupported';

/** Every language's explicit path-detection decision, derived from this module's rules. */
export const TEST_DETECTION_DECISIONS: ReadonlyMap<string, TestDetectionDecision> = new Map([
  ...[...TEST_DETECTION_LANGUAGES].map(language => [language, 'supported'] as const),
  ...[...TEST_DETECTION_UNSUPPORTED_LANGUAGES].map(language => [language, 'unsupported'] as const),
]);

/**
 * What a path-only decision cannot see for a language, in the words a disclosure can use.
 *
 * `TEST_DETECTION_DECISIONS` reports a language `supported` as soon as ONE path convention
 * exists, so Rust read as fully covered while 79% of a real workspace's tests — every inline
 * `#[cfg(test)]` module — were invisible. A consumer that reports a coverage gap must say this
 * rather than imply the path rules are the whole story.
 */
export const TEST_DETECTION_CAVEATS: ReadonlyMap<string, string> = new Map([
  ['Rust', 'a Rust test in an inline `#[cfg(test)] mod` is recognized from its `#[test]` '
    + 'attribute, not its path, and an unattributed helper inside such a module is counted as '
    + 'production code. A call made INSIDE a macro body — `assert_eq!(sha256_hex(x), y)`, the '
    + 'usual shape of a Rust assertion — is not a call-graph edge, so code exercised only '
    + 'through an assertion macro still reports no reaching test'],
]);

export function isTestFile(filePath: string): boolean {
  const name = filePath.replace(/\\/g, '/');
  return TEST_PATH_RULES.some(rule => rule.pattern.test(name));
}
