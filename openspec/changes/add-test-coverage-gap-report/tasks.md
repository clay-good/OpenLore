# Tasks — Test coverage gap report

## 1. Gap computation
- [x] Compute the inverse of test-selection backward reachability over the whole graph: functions in no
      test's reachable set. Deterministic; no test execution / coverage tool / runtime.
- [x] Exclude test files, generated, vendored. Label untested-with-no-caller distinctly from dead.
- [x] If an internal coverage analyzer exists, expose its gap output; else compute inverse reachability.

## 2. Ranking + soundness
- [x] Rank by existing labels (`hub`, `chokepoint`) then raw fan-in; no composite score / new constant;
      attach labels + evidence.
- [x] Enforce the soundness contract: report only "no reaching test"; never claim "tested/covered";
      disclose that reachable-from-a-test ≠ behavior-verified.

## 3. MCP + CLI surface
- [x] Opt-in `report_coverage_gaps` (whole repo; region scope; diff scope) with full input + structured
      output schemas; classify as conclusion; opt-in preset only; carry the soundness caveat.
- [x] CLI equivalent.

## 4. Tests & fixtures
- [x] Tested hub + untested hub + untested leaves → untested hub top, leaves sink, tested hub absent.
- [x] Soundness: no symbol ever reported as "tested."
- [x] Exclusions: test/generated/vendored excluded; untested entry point reported (untested-not-dead).
- [x] Diff-scoped report returns only changed untested symbols.
- [x] Determinism.

## 5. Verify & dogfood
- [x] `npm run lint`, `npm run typecheck`, `npm run test:run`, `npm run build` green.
- [x] Dogfood: run on a real repo; sanity-check that the top gaps are genuinely important + untested.

## 6. Docs
- [x] Document the tool, the structural (not executed-line) coverage definition, the gaps-only soundness
      contract, and the untested-vs-dead distinction. Update the MCP tool count guard.
