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

## 3. Tests
- [x] `call-graph.test.ts`: this→sibling (self_cls), this→inherited, super→parent (not child),
      same-name two-class same-file, cross-file own-file affinity, super→imported-parent (not decoy),
      noise-list name (parse/map) resolves, unresolved this dropped (no external leaf).
- [x] Update `no-regression.test.ts` snapshot (additive: the two previously-missing `this.` edges).

## 4. Verify
- [x] `npm run build`; `vitest run src examples` green (273 files / 5369 tests).
- [x] Adversarial e2e (two agents): cross-file false edges + noise-filter swallowing found and fixed;
      cross-tool benefit confirmed (analyze_impact fanIn, find_dead_code false-dead removed, find_path,
      error-propagation `escapes` up / `unresolvedSelfCalls` down, JS parity, Python no-regression).
- [x] Real-repo dogfood: all `Logger.*`→`this.log()` edges resolve; `handleBatch`
      `unresolvedSelfCalls` 39→2, `functionsAnalyzed` 449→578, `handledInternally` 2→32.
