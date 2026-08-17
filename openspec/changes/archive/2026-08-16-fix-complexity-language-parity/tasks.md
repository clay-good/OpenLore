# Tasks — fix complexity language parity

## Implementation
- [x] Per-language CC pattern table in `call-graph-complexity.ts` (:11-12): Go/Rust/Swift
      brace-style keyword patterns; Ruby (`if`/`elsif`/`unless`/`while`/`until`/`when`/
      `rescue`/`and`/`or`); Elixir (`if`/`unless`/`case`/`cond`/`rescue`); keyword-boundary
      anchored, no required parens
- [x] Make the C-family default an explicit language listing (TS/JS/Java/C/C++/C#/PHP/Kotlin/
      Dart/Scala), not a catch-all fallback
- [x] Unlisted language → `cyclomaticComplexity` absent/null at the Pass 6 assignment
      (call-graph.ts:4569), never a silent 1
- [x] Derive a `complexity` capability in the per-language registry (`language-support.ts`) from
      the pattern table, so the matrix discloses coverage and cannot over-claim

## Verification
- [x] Repro fixtures pinned: Go body with 3 ifs + 1 for + 1 case → CC 6 (parity with the
      paren'd TS-style equivalent); Ruby if/elsif/while → CC 4; Rust/Swift/Elixir shape
      fixtures likewise
- [x] Calibration check: for languages with a CFG overlay, regex CC tracks CFG-known branch
      counts on the fixture set
- [x] Unlisted-language fixture: node carries no complexity value; capability matrix shows the
      honest gap
- [x] Existing complexity/hotspot ranking tests green (value rises for the five languages are
      the fix, reviewed)
- [x] Full suite green

## Spec
- [x] `analyzer` delta: ADD PerLanguageComplexityEstimation
