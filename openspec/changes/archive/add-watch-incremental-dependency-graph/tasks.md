# Tasks — Live dependency-graph edges in watch mode

> Status: DRAFT (2026-06-20). Incremental file→file import edges in `mcp --watch`; reuses the builder's
> resolution logic. Global metrics deferred to full `analyze`.

## 1. Shared edge resolution
- [x] Extract `computeFileImportEdges(fromAbs, analysis, fileSet, rootDir, extensions?)` from
      `DependencyGraphBuilder.buildEdges` (pure; returns edges, caller owns adjacency).
- [x] `buildEdges` calls it — behavior-preserving (existing dependency-graph tests stay green).

## 2. Watcher incremental patch
- [x] `McpWatcher.updateDependencyGraph(changedFiles)`: read `dependency-graph.json`; for each changed
      file that is a graph node, re-parse imports (`ImportExportParser`), compute new edges via the
      shared helper, replace that file's import edges, recompute in/out-degree, persist.
- [x] Preserve `httpEdge` / `isCallEdge` edges (the watcher doesn't rebuild them).
- [x] Called from `handleBatch` (step 3.6, after the text-line update); guarded + best-effort, no throw.
- [x] No-op when `dependency-graph.json` is absent.

## 3. Tests
- [x] Watcher integration: edit an import (`./b` → `./c`) → `dependency-graph.json` drops the old edge,
      adds the new, and recomputes degrees.
- [x] Existing dependency-graph + import-parser suites pass unchanged (shared-helper refactor).
- [ ] (optional) Unit test for `computeFileImportEdges` in isolation — currently covered transitively
      via `buildEdges` + the watcher integration test.

## 4. Out of scope (documented in proposal)
- [ ] HTML files in watch (separate HTML-watch follow-up).
- [ ] Incremental global metrics (pageRank/betweenness/clusters) — full `analyze` only.
- [ ] New-file node creation + deletion reconciliation in watch mode.
