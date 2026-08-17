/**
 * Tests for the canonical cross-language test-file predicate. These lock in the
 * coverage that the call-graph builder previously LACKED (its narrower local copy
 * let directory-convention tests leak into the production graph and dropped
 * `tested_by` edges) — call-graph and artifact-generator now share this predicate.
 */

import { describe, it, expect } from 'vitest';
import { isTestFile, TEST_DETECTION_DECISIONS, TEST_DETECTION_LANGUAGES } from './test-file.js';
import { CALLGRAPH_LANGUAGES } from './call-graph.js';

const FIXTURES: Record<string, { test: string; source: string }> = {
  TypeScript: { test: 'src/foo.test.mts', source: 'src/foo.mts' },
  JavaScript: { test: 'src/foo.spec.cts', source: 'src/foo.cjs' },
  Python: { test: 'tests/unit/test_foo.py', source: 'src/foo.py' },
  Go: { test: 'pkg/foo_test.go', source: 'pkg/foo.go' },
  Rust: { test: 'tests/nested/integration.rs', source: 'src/latest.rs' },
  Ruby: { test: 'spec/models/user_spec.rb', source: 'lib/spectrum.rb' },
  Java: { test: 'src/test/java/com/example/Foo.java', source: 'src/main/java/com/example/Foo.java' },
  Kotlin: { test: 'src/FooSpec.kt', source: 'src/Foo.kt' },
  PHP: { test: 'tests/Unit/FooTest.php', source: 'src/Foo.php' },
  'C#': { test: 'src/FooTests.cs', source: 'src/Contest.cs' },
  'C++': { test: 'tests/unit/foo.cpp', source: 'src/foo.cpp' },
  C: { test: 'tests/unit/foo.c', source: 'src/foo.c' },
  Swift: { test: 'Tests/AppTests/FooTests.swift', source: 'Sources/App/Foo.swift' },
  Scala: { test: 'src/FooSpec.scala', source: 'src/Foo.scala' },
  Dart: { test: 'test/widget_test.dart', source: 'lib/widget.dart' },
  Lua: { test: 'spec/unit/foo_spec.lua', source: 'src/foo.lua' },
  Elixir: { test: 'test/unit/foo_test.exs', source: 'lib/foo.ex' },
  Bash: { test: 'tests/unit/foo.sh', source: 'scripts/foo.sh' },
};

describe('isTestFile', () => {
  it('covers every call-graph language with realistic test and source paths', () => {
    expect(new Set(Object.keys(FIXTURES))).toEqual(CALLGRAPH_LANGUAGES);
    expect(new Set(TEST_DETECTION_DECISIONS.keys())).toEqual(CALLGRAPH_LANGUAGES);
    expect(new Set(Object.keys(FIXTURES))).toEqual(TEST_DETECTION_LANGUAGES);

    for (const language of CALLGRAPH_LANGUAGES) {
      const fixture = FIXTURES[language];
      expect(isTestFile(fixture.test), `${language}: ${fixture.test}`).toBe(true);
      expect(isTestFile(fixture.source), `${language}: ${fixture.source}`).toBe(false);
    }
  });

  it('detects directory-convention and framework test layouts', () => {
    const tests = [
      'src/foo.test.ts',
      'src/foo.spec.tsx',
      'src/__tests__/foo.ts',          // ← missed by the old call-graph copy
      'tests/foo.ts',                  // ← missed
      'tests/foo.rb',                  // ← missed
      'tests/foo.php',                 // ← missed
      'test/foo.py',                   // ← missed
      'pkg/foo_test.go',
      'app/test_foo.py',
      'src/FooTest.java',
      'src/FooSpec.kt',                // ← missed
      'src/FooTest.scala',             // ← missed
      'src/FooTests.java',             // JUnit plural suffix (Spring convention)
      'src/PaymentIT.java',            // Maven failsafe integration test
      'src/main/PaymentIT.kt',         // Kotlin integration test
      'src/test/java/com/example/AnythingHere.java', // Maven/Gradle src/test tree
      'src/test/kotlin/com/example/Svc.kt',
      'pkg/widget_test.cpp',           // C++ test
      'pkg/widget_test.cc',            // C++ test
      'pkg/widget_test.cxx',           // C++ test
    ];
    for (const f of tests) expect(isTestFile(f), f).toBe(true);
  });

  it('does not flag ordinary source files', () => {
    const nonTests = [
      'src/foo.ts',
      'src/app-config.ts',
      'src/contest.ts',                // contains "test" but not a test file
      'src/latest.ts',
      'lib/protest.py',
      'src/Foo.java',
      'src/main/java/com/example/Payment.java',  // production Java source
      'src/Unit.java',                            // ends in "it" lowercase, not IT
      'src/main/resources/app.properties',        // src/main, not src/test
    ];
    for (const f of nonTests) expect(isTestFile(f), f).toBe(false);
  });

  it('accepts non-PascalCase prefixes for suffix-based conventions', () => {
    for (const path of [
      'src/fooTest.cs',
      'src/Foo.BarTests.cs',
      'src/Foo_Tests.cs',
      'src/Foo.BarTest.php',
      'Tests/AppTests/foo.barTests.swift',
    ]) {
      expect(isTestFile(path), path).toBe(true);
    }
    expect(isTestFile('src/Contest.cs')).toBe(false);
  });

  it('covers each required suffix and directory convention independently', () => {
    for (const path of [
      'lib/foo_test.rb',
      'lib/foo_spec.rb',
      'spec/models/support.rb',
      'src/foo_test.exs',
      'lib/foo_test.dart',
      'src/foo_spec.lua',
      'Sources/FooTest.swift',
      'Sources/FooTests.swift',
      'Tests/AppTests/Support.swift',
    ]) {
      expect(isTestFile(path), path).toBe(true);
    }
  });

  it('normalizes Windows path separators', () => {
    expect(isTestFile('src\\__tests__\\foo.ts')).toBe(true);
    expect(isTestFile('src\\foo.test.ts')).toBe(true);
  });
});
