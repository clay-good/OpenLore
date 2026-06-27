# Tasks — resolve this./super. method calls

## 1. Capture
- [x] Extend `TS_CALL_QUERY` with `member_expression object: (this)` and `object: (super)` arms
      (TS+JS share this extractor).

## 2. Resolve
- [x] `resolveSelfMethod` helper: `this`→enclosing class then `extends` ancestors; `super`→ancestors
      only; cycle-guarded; confidence `self_cls`.
- [x] Hoist `extractClassRelationships(files)` before the Pass-2 resolution loop; reuse for Pass 7.
- [x] File/import affinity tiebreak (own file → imported-from file → single candidate → skip).
- [x] Receiver-aware noise filter: bypass `isIgnoredCallee` for this/super (TS) and self/cls (Python).
- [x] Drop an unresolved this/super call instead of minting `external::this.m`.
- [x] Nested-scope guard (adversarial round 2): the className walk STOPS at an object-literal /
      function / method boundary before the class, so an object-literal-method/nested-function inside a
      class method does not inherit the class name and produce a false `self_cls` edge.
- [x] Class-expression className capture (enhancement round): the walk handles a `class` expression —
      named keeps its own name, anonymous takes the `const`/assignment binding — so class-expression
      methods resolve their `this.m()` calls.
- [~] Unique identity for nested functions: implemented, then REVERTED — conflicts with intentional
      collapse semantics (member re-assignment, container homonyms) and the stable-identity model
      (~30 tests across structural-diff/impact-certificate/stable-id/scip/cross-service/anchoring; a
      positional discriminator is unstable across edits). Deferred to its own change. See proposal.

## 3. Tests
- [x] `call-graph.test.ts`: this→sibling (self_cls), this→inherited, super→parent (not child),
      same-name two-class same-file, cross-file own-file affinity, super→imported-parent (not decoy),
      noise-list name (parse/map) resolves, unresolved this dropped (no external leaf), nested
      object-literal/function this-call produces NO false self_cls edge.
- [x] Update `no-regression.test.ts` snapshot (additive: the two previously-missing `this.` edges).

## 4. Verify
- [x] `npm run build`; `vitest run src examples` green (273 files / 5370 tests).
- [x] Adversarial e2e round 1 (two agents): cross-file false edges + noise-filter swallowing found and
      fixed; cross-tool benefit confirmed (analyze_impact fanIn, find_dead_code false-dead removed,
      find_path, error-propagation `escapes` up / `unresolvedSelfCalls` down, JS parity, Python ok).
- [x] Adversarial e2e round 2 (three agents): error-prop × this/super interaction (18 scenarios, 0
      unsound/hang/crash); exotic-syntax fuzz (30 scenarios) found the nested-scope false edges →
      FIXED with the className-boundary guard; real-repo correctness audit (26 sampled edges all
      correct, 0 cross-file). Post-fix the real repo dropped 18 false edges (self_cls 433→415).
- [x] Real-repo dogfood: all `Logger.*`→`this.log()` edges resolve; `handleBatch`
      `unresolvedSelfCalls` 39→2, `functionsAnalyzed` 449→580, `handledInternally` 2→32.
