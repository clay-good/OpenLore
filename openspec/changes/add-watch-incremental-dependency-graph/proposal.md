# Live dependency-graph edges in watch mode

> Status: IMPLEMENTED (2026-06-20). Shipped in the watch path: commit `7aaf377` "feat(watcher): keep dependency-graph.json import edges live in watch mode" (`src/core/services/mcp-watcher.ts`). (Status corrected 2026-06-25 — was stale DRAFT.)
> Closes a systemic watch-mode staleness: the call graph (function→function) is kept live by the
> watcher, but the **dependency graph** (file→file imports) was never updated incrementally — it froze
> until a full `analyze`. This affects every language's import edits, not just HTML assets.

## Why

`get_file_dependencies` reads the static `dependency-graph.json` artifact (`graph.ts`). The MCP watcher
incrementally maintains signatures, the call-graph EdgeStore, the text-line index, and the vector index
— but **never touches `dependency-graph.json`**. So in `mcp --watch`, the moment an import is added,
removed, or re-pointed, the file→file dependency view goes stale until the next full `analyze`:

- `get_file_dependencies("x")` returns the *old* imports.
- file-level in/out-degree, and anything reading the dep-graph artifact, drift.

(The `serve` daemon hides this by scheduling a debounced **full** re-analyze via `onBatchFlushed`, but
that is O(repo); plain `mcp --watch` has no such fallback.)

The call graph got cheap incremental updates (EdgeStore) because its edge ops are O(change). The
dependency graph carries **global metrics** — pageRank, betweenness, clusters — that are O(graph), which
is why it piggybacked on the full re-analyze. But the part `get_file_dependencies` actually serves — the
**edges** — can be patched just as cheaply.

## What changes

1. **Incremental edge patch in the watcher.** On each batch, for every changed file already present as a
   dependency-graph node, re-resolve its imports and replace that file's import edges in
   `dependency-graph.json`, then recompute file in/out-degree. O(change).

2. **Shared resolution — no drift.** The per-file edge logic is extracted from `buildEdges` into an
   exported `computeFileImportEdges(fromAbs, analysis, fileSet, rootDir, extensions?)`, used by **both**
   the full builder and the watcher, so incremental and full results can't diverge.

3. **HTTP / call-synthesized edges preserved.** The patch drops only a changed file's *import* edges
   (those it owns); `httpEdge` and `isCallEdge` edges — which the watcher does not rebuild — are kept.

4. **Global metrics deferred, by design.** pageRank, betweenness, and clusters are O(graph); they are
   left to the next full `analyze` (the same posture the call graph's hub/community stats already take
   in watch mode). Only the edges + degrees that `get_file_dependencies` serves are kept live.

   **Consequence — temporary metric divergence:** after a watch patch, a node's `inDegree`/`outDegree`
   are fresh while its `pageRank`/`betweenness`/`cluster` reflect the pre-edit edge set (e.g. a node may
   show a new `inDegree` but an unchanged `pageRank`). This is acceptable for an advisory artifact —
   `get_file_dependencies` consumes the edges/degrees, not the global metrics — and self-heals on the
   next full `analyze`. Tools must not assume degree-vs-pageRank consistency mid-watch.

## What does NOT change

- **No LLM, no new artifact.** Patches the existing `dependency-graph.json` in place.
- **Full-build behavior is identical** — `buildEdges` now calls the extracted helper; existing
  dependency-graph tests pass unchanged.
- **The call-graph / signature / vector / text-line lanes are untouched.**

## Scope boundaries

- **HTML files are not watched** (they are not in `SOURCE_EXTENSIONS`), so HTML asset edges still
  refresh only on full `analyze` — that is the separate HTML-watch follow-up.
- **Global metrics** (pageRank/betweenness/clusters) are not recomputed incrementally; they refresh on
  full `analyze`.
- **New files** (not yet a dep-graph node) are added by the next full `analyze`, not patched in.
- **Deletions** are not reconciled in watch mode (consistent with every other watcher lane).

## Risk

**Low.** The full-build path is refactored to reuse the same extracted function (behavior-preserving,
covered by existing tests). The watcher addition is a guarded, best-effort JSON patch that no-ops when
no dependency graph exists and never throws into the batch loop.
