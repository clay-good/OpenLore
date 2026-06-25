# Reconcile file create & delete in watch mode

> Status: IMPLEMENTED (2026-06-20, commit `7ea8240` "feat(watcher): reconcile file create & delete in watch mode"). (Status corrected 2026-06-25 — was stale DRAFT.) Stacks on the watch-mode work (dependency-graph + HTML live). Closes the
> last watch-mode hole: the watcher reconciled file MODIFICATIONS across every lane, but not CREATES or
> DELETES.

## Why

The watcher listened only to chokidar `'change'`. So:

- **Deleting** a file left phantom state in every lane — its call-graph nodes/edges, signatures,
  text-line rows, vector rows, and dependency-graph node/edges all lingered until a full `analyze`.
  `search_code` and `get_file_dependencies` returned results pointing at a file that no longer exists.
- **Creating** a file made it invisible — no symbols, no edges, not searchable — until a full `analyze`.

Modification was made hole-free across all lanes earlier this session; create/delete is the symmetric
other half.

## What changes

1. **`'add'` events** route through the existing change pipeline (insert is a no-op delete + add), so a
   new file is picked up by signatures, the call graph, the text-line index, and the vector index.
   `updateDependencyGraph` now **adds a node** for a changed file that isn't yet in the graph, plus its
   outgoing import edges. (`ignoreInitial: true` means only files created *after* start fire `'add'` —
   no initial-scan storm.)

2. **`'unlink'` events** route to a new `handleDeletions` that removes the file from **every** lane:
   - **Call graph:** `deleteEdgesForFile` (caller OR callee — no dangling incoming edges) +
     `deleteNodesForFile` + `deleteCfgForFile` + `deleteClassesForFile`.
   - **Signatures:** drop the file's `FileSignatureMap` from `llm-context.json`.
   - **Text-line index:** `TextLineIndex.updateFiles(out, [], [rel])`.
   - **Vector index:** `VectorIndex.updateFiles` with no nodes for the path → deletes its rows.
   - **Dependency graph:** remove the node and every edge touching it (source or target), recompute
     degrees, **atomic write** (tmp + `rename`).

3. **Coalescing.** Deletions share the same debounce as changes via a `pendingDeletions` set; a flush
   processes deletions first (remove stale state) then re-indexes changes. A re-create supersedes a
   pending delete and vice-versa, so a delete-then-recreate burst resolves to a re-index.

## What does NOT change

- **No LLM.** Reuses existing deterministic store/index primitives.
- **Modification behavior is unchanged** — the change pipeline is untouched except for the dependency-
  graph new-node addition.
- **Single-flight / debounce invariants preserved** — deletions flow through the same timers and
  running-latch.

## Scope boundaries

- **New-file incoming edges.** A new file gets a node + its *outgoing* imports; *incoming* edges
  (existing files that import it) appear when those importers are next touched or on the next full
  `analyze`. Resolving them eagerly would require re-parsing every potential importer.
- **Global dependency-graph metrics** (pageRank/betweenness/clusters) remain deferred to full `analyze`.
- **Stale file hash on delete.** The EdgeStore's per-file content hash for a deleted path is left; it is
  harmless (a same-path recreate re-parses on content change).

## Risk

**Low–medium.** The coalescing change is the delicate part; it preserves the single-flight latch and
debounce, and supersession prevents a delete/recreate race from leaving stale state. Each lane's
deletion reuses an existing, tested primitive and is best-effort (a failure in one lane never blocks the
others).
