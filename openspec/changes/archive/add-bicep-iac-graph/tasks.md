# Tasks — Bicep IaC graph

## 1. Types & gating
- [x] Add `Bicep` to the `IacLanguage` union and `IAC_LANGUAGES` array
  (`src/core/analyzer/iac/types.ts`).

## 2. Extractor
- [x] New `src/core/analyzer/iac/bicep.ts`:
  - [x] `extractBicep(files)` scans `.bicep` files with a tolerant hand-rolled block scanner.
  - [x] Nodes: `resource` (typed, `@version` stripped), `existing`→`data`, nested children with a
        `parent` edge, loop (`= [for…]`) → single node; `param`/`var`/`output`/`module`.
  - [x] File-scoped addresses (`<filePath>::<symbol>`); references resolve within-file only.
  - [x] Edges: `parent:`, `dependsOn:` (depends_on), bare-symbol refs in values incl. `${…}` and
        `.prop` access bases (references). Property keys / function names / string text are not refs.
  - [x] Local `module './x.bicep'` → cross-file edges to that file's resources + `ClassNode` members;
        registry `br/…`/`ts/…` module → external node.
  - [x] Dynamic / unresolved refs emit no edge.

## 3. Detection & dispatch
- [x] `detectLanguage` returns `Bicep` for `.bicep` (`src/core/analyzer/signature-extractor.ts`).
- [x] `extractSignatures` gains a `Bicep` case (search_code coverage).
- [x] `index.ts` wires `extractBicep` into `buildIacGraph`.
- [x] `artifact-generator.ts`: add `Bicep` to `CALL_GRAPH_LANGS`.

## 4. Tests & fixtures
- [x] `src/core/analyzer/iac/bicep.test.ts` — resources/params/vars/outputs/modules, parent + dependsOn
      + symbol-ref edges, existing→data, nested children, loop single-node, local module cross-file link,
      remote module external, file-scoping (no cross-file collision), determinism, dynamic no-edge.
- [x] Fixtures under `src/core/analyzer/iac/fixtures/bicep/` (multi-file incl. a local module target).
- [x] Extend `integration.test.ts` to assert Bicep nodes/edges surface through `CallGraphBuilder`.

## 5. Verify & dogfood
- [x] `npm run lint`, `npm run typecheck`, `npm run test:run`, `npm run build` green.
- [x] Dogfood: `openlore analyze` a real repo with `.bicep` files; `analyze_impact` a module/resource;
      record results in `DOGFOOD-bicep-iac-graph.md`.

## 6. Docs
- [x] Add a Bicep section to `docs/iac.md`; remove Bicep from the "future specs" line.
- [x] Update README IaC ecosystem mention / counts; update cross-domain ecosystem count if asserted.
- [x] Mark spec-07's deferred Bicep item as shipped; set proposal status to IMPLEMENTED.
