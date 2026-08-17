# Tasks — fix-test-detection-language-parity

## Implementation
- [x] Extend `isTestFile` (test-file.ts:20-32) with per-language patterns: C# `*Test(s).cs`;
      Ruby `_test.rb` / `_spec.rb` / `spec/**`; PHP `*Test.php` + nested `tests/**`; Elixir
      `test/**/*_test.exs` + `*_test.exs`; Dart `*_test.dart`; Lua `spec/**/*_spec.lua`;
      Swift `*Test(s).swift` + `Tests/` tree; Rust `tests/**/*.rs`; nested `tests/**` for
      existing directory-convention languages; `.mts`/`.cts` in the JS/TS suffix set (:23)
- [x] Export a per-language test-detection declaration from test-file.ts (which languages the
      patterns claim to cover) — the single source the registry and tests derive from
- [x] Add `testDetection` to `CAPABILITIES` (language-support.ts:41-51) + description, derived
      from the test-file.ts declaration (same derivation discipline as the other capabilities)
- [x] Surface the new column in `get_language_support` output and the CODEBASE.md coverage
      table (codebase-digest.ts)
- [x] Update the doc-comment coverage list (test-file.ts:10-18) in the same commit; note the
      Rust inline `#[cfg(test)]` path-predicate boundary explicitly

## Verification
- [x] Conformance fixtures per language: realistic test-file AND non-test-file path sets
      asserting `isTestFile` verdicts (e.g. `FooTests.cs` true, `src/Foo.cs` false;
      `spec/models/user_spec.rb` true; `tests/Unit/FooTest.php` true; `test/foo_test.exs`
      true; `Tests/AppTests/FooTests.swift` true; `tests/integration.rs` true)
- [x] Parity guard: every `CALLGRAPH_LANGUAGES` member (call-graph.ts:2118-2121) either has
      declared test-detection patterns or the registry reports `testDetection` unsupported —
      a new callGraph language without a test-detection decision fails CI
- [x] Registry test extends language-support.test.ts: `testDetection` flag matches the
      test-file.ts declaration per language (no over-claim)
- [x] select_tests/coverage-gaps honesty verdicts (test-impact.ts:236-253,
      coverage-gaps.ts:233-249) flip from partial/none to full on a mixed-language fixture
      once detection works
- [x] Payload-budget check: `get_language_support` growth stays under the mcp-presets.test.ts
      ceiling
- [x] Full suite green; note shifted graph stats (hubs/entry-points/dead-code) as intended

## Spec
- [x] `analyzer` delta: ADD TestFileDetectionCoversSupportedLanguages,
      TestDetectionCapabilityIsRegistryDeclared
