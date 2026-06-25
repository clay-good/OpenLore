# Tasks — Call resolution recall

> Scope finding (2026-06-25): a structural audit during implementation found items 2 and 3 already
> delivered by the shipped CHA pass (`add-type-hierarchy-resolved-dispatch`). They are checked off as
> "already satisfied (CHA)" with a cross-reference rather than re-implemented. This change ships item 1
> (re-export/barrel resolution) and item 4 (resolution provenance).

## 1. Re-export / barrel resolution
- [x] Follow `export { x } from`, `export * from`, default re-exports through any barrel depth to the
      true definition; detect + terminate cycles. Gate per language; fail-soft.
      (`buildResolvedImportMap` in `import-resolver-bridge.ts`; threaded into Pass 2 + Pass 7 + CHA.)

## 2. Interface / override edges
- [x] **Already satisfied (CHA).** `synthesizeVirtualDispatchEdges` links interface/abstract/overridable
      calls to in-repo implementors as labeled candidates (`synthesizedBy: cha-declared-type|cha-name-only`);
      `synthesizeOverrideEdges` links overrides (`synthesizedBy: override`). Subtree index includes
      `implements` edges, so interface receivers resolve. A single implementor is the one-element case.

## 3. Single-binding indirection
- [x] **Already satisfied (CHA).** A uniquely-bound injected/factory dependency is the single-implementor
      case of CHA subtree dispatch; multi-binding/runtime stays unresolved + disclosed via the
      confidence-boundary `knownUnknowable` channel.

## 4. Provenance labels
- [x] Tag re-export-resolved call edges `re_export` (new `EdgeConfidence`, cost 1); direct imports stay
      `import`. Interface/override candidates keep `synthesized` + `synthesizedBy`. Reuses the existing
      confidence-boundary disclosure (no new channel).
- [x] Conclusions (`analyze_impact`, `find_dead_code`, `select_tests`, `blast_radius`,
      `report_coverage_gaps`) surface provenance via the shared confidence-boundary machinery
      (`edgeBasis` counts `re_export` as direct; `directResolvedOnly` excludes only synthesized).

## 5. Tests & fixtures
- [x] Barrel: call through re-export resolves to true def at `re_export`; implementation no longer dead.
- [x] `export *` barrel resolves; depth-N chain resolves to the leaf.
- [x] Direct import stays `import`; cross-file disambiguation picks the imported definition.
- [x] Re-export cycle terminates.
- [x] Determinism; superset-of-`buildBaseImportMap` property; regression gate (same-file edges keep label,
      only barrel-crossed edges wear `re_export`).
- [x] Interface/single-binding behavior covered by the existing `cha.test.ts` (unchanged).

## 6. Verify & dogfood
- [x] `npm run lint`, `npm run typecheck` (tsc), `npm run test:run` (5063 pass), `npm run build` green.
- [x] Dogfood: re-analyzed this repo — `name_only` 1067→87, `import` 0→1326, `re_export` 0→21,
      `external` 8742→8563, `type_inference` unchanged. See `DOGFOOD-call-resolution-recall.md`.

## 7. Docs
- [x] Documented each resolution class, the re_export provenance, the per-language gating/fail-soft
      behavior, and the CHA cross-reference (proposal + analyzer spec delta).
