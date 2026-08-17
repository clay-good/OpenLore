# Test-file detection language parity: every callGraph-backed language deserves a working `isTestFile`

> Status: IMPLEMENTED AND ARCHIVED (2026-08-16). The canonical test-file predicate was
> single-sourced (good) but its pattern coverage badly trails the 18-language call-graph
> matrix: C#, Ruby, PHP, Elixir, Dart, Lua, Swift, and Rust test conventions are partly or
> wholly undetected, so `select_tests`, `report_coverage_gaps`, dead-code stats, and every
> `tested_by` edge are quietly wrong on those languages. Fix the patterns per supported
> language, and make the boundary statically inspectable via a derived `testDetection`
> capability in the language-support registry.

## The gap

- **One predicate, eight language holes.** `isTestFile` (`test-file.ts:20-32`) is the shared
  predicate for the call-graph builder, artifact generator, watcher, coverage analyzer, and
  public-surface eligibility. Verified against its own regexes:
  - **C#**: no pattern matches `.cs` at all — `FooTests.cs`/`FooTest.cs` (xUnit/NUnit) are
    production code to the graph.
  - **Ruby**: `foo_test.rb` misses (`:26` covers `py|go|cpp|cc|cxx`, no `rb`); `foo_spec.rb`
    misses (`:29` requires CamelCase `FooSpec.rb`); the RSpec `spec/` directory misses
    (`:27` matches only `tests?/`). RSpec and Minitest are both effectively undetected.
  - **PHP**: `FooTest.php` misses (`:28` covers `java|kt|scala` only); PHPUnit's nested
    `tests/Unit/Foo.php` misses (`:27`'s `[^/]+` is single-level).
  - **Elixir**: `.exs` appears in no pattern — ExUnit is entirely undetected.
  - **Dart**: `test/foo_test.dart` misses (`:26` has no `dart`; `:27`'s extension set has no
    `dart`).
  - **Lua**: busted's `spec/foo_spec.lua` misses on both the directory and the suffix.
  - **Swift**: `FooTests.swift` and the SwiftPM `Tests/` tree miss (`:27` is lowercase
    `tests?/` only).
  - **Rust**: integration tests under `tests/*.rs` miss (`:27`'s extension set has no `rs`).
  - **General**: nested `tests/**` trees miss everywhere (`:27` is single-level), and JS/TS
    `.mts`/`.cts` test variants miss (`:23` covers `ts|tsx|js|jsx|mjs|cjs`).
- **The blast radius is every test-aware conclusion.** An undetected test file enters the
  production graph as ordinary code: no `isTest` node flag, no `tested_by` edge — so
  `select_tests` returns empty, `report_coverage_gaps` over-reports, `find_dead_code` lists
  test-only helpers as dead, and hubs/entry-points/stats absorb test scaffolding.
- **The honesty layer exists but has nothing to stand on.** `select_tests` already computes a
  `testDetection: full|partial|none` verdict with caveats (`test-impact.ts:236-253`), mirrored
  by coverage-gaps (`coverage-gaps.ts:233-249`) — the *disclosure* is right; the *detection*
  under it is wrong. And nothing static tells an agent "test detection is unsupported for
  language L": the language-support registry (`language-support.ts:41-51`, derived per
  capability) has no `testDetection` column, so a quiet `select_tests` on Ruby is
  uninterpretable.

## What changes

1. **Per-language patterns in the one shared predicate** (`test-file.ts:20-32`): C# `*Test.cs`
   / `*Tests.cs`, Ruby `_test.rb` / `_spec.rb` / `spec/` + nested `spec/**`, PHP `*Test.php` +
   nested `tests/**`, Elixir `test/**/*_test.exs` + `*_test.exs`, Dart `*_test.dart`, Lua
   `spec/**/*_spec.lua`, Swift `*Tests.swift` / `*Test.swift` + `Tests/` tree, Rust
   `tests/**/*.rs`, nested `tests/**` for the existing directory-convention languages, and
   `.mts`/`.cts` in the JS/TS suffix set. Deterministic path regexes only — no content
   sniffing, no new tuning constants. Rust's inline `#[cfg(test)]` modules are content-level
   and stay out of scope for a path predicate (disclosed in the doc comment).
2. **A derived `testDetection` capability** in the language-support registry
   (`language-support.ts:41-51` `CAPABILITIES`): backed by a per-language declaration exported
   from `test-file.ts` itself (the same file that owns the patterns), so — like every other
   capability — the matrix cannot over-claim. `get_language_support` and the CODEBASE.md
   coverage table gain the column, making "quiet `select_tests` on language L" statically
   interpretable.
3. **Doc comment stays honest** — the per-language coverage list in `test-file.ts:10-18`
   (which today honestly omits the missing languages) is updated in the same commit as the
   patterns, and the conformance test reads from the declaration, not the comment.
4. **Conformance tests + a parity guard**: per-language fixture path sets (realistic test and
   non-test paths per language, asserting `isTestFile` verdicts), plus a guard that every
   language `CALLGRAPH_LANGUAGES` (`call-graph.ts:2118-2121`, 18 languages) claims is
   callGraph-backed either has test-detection patterns or the registry reports `testDetection`
   unsupported for it — divergence fails CI, not the user.

## Why this is in scope

`tested_by` edges are substrate: `select_tests`, `report_coverage_gaps`, `blast_radius`'s
tests-to-run, and dead-code candidates all rest on this one predicate. The fix is the same
class as the pass-1 single-sourcing fix (`fix-language-detection-single-source`): deterministic,
local, pattern-precision work on an existing capability, with the boundary made inspectable
instead of guessed.

## Impact

- Files: `src/core/analyzer/test-file.ts` (patterns + per-language declaration + doc comment),
  `src/core/analyzer/language-support.ts` (derived `testDetection` capability),
  `src/core/services/mcp-handlers/language-support.ts` + `codebase-digest.ts` (column
  surfaces), conformance + parity tests.
- Specs: `analyzer` — 2 ADDED requirements (TestFileDetectionCoversSupportedLanguages,
  TestDetectionCapabilityIsRegistryDeclared).
- Tool surface: no new tool. `get_language_support` output grows by one capability column —
  small, measured against the payload-budget ceiling in `mcp-presets.test.ts`.
- Risk: medium, intended, disclosed. Newly-detected test files *leave* the production graph:
  hubs/entry-points/stats shift, `tested_by` edges appear, dead-code candidates may grow on
  affected repos — the same disclosed re-baselining class as the pass-1 language-detection fix.
