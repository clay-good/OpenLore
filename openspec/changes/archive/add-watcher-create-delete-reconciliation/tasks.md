# Tasks — Reconcile file create & delete in watch mode

> Status: DRAFT (2026-06-20). Stacks on the dependency-graph + HTML watch work.

## 1. Events + coalescing
- [x] chokidar `'add'` → `enqueue` (same pipeline as `'change'`); `'unlink'` → `enqueueDeletion`.
- [x] `pendingDeletions` set; `armFlush` shared by both; `flush` drains both (deletions first).
- [x] Supersession: an enqueue clears a pending delete for the path and vice-versa.
- [x] Single-flight latch + debounce reschedule account for both sets.

## 2. Create
- [x] `updateDependencyGraph` adds a node (+ outgoing edges) for a changed file not yet in the graph.

## 3. Delete (`handleDeletions`)
- [x] Call graph: `deleteEdgesForFile` (both directions) + nodes + cfg + classes, one transaction.
- [x] Signatures: drop the file's `FileSignatureMap`; persist.
- [x] Text-line index: `updateFiles([], [rel])`.
- [x] Vector index: `updateFiles([], {rel}, …)` → deletes rows.
- [x] Dependency graph: `removeFromDependencyGraph` — drop node + edges touching it, recompute degrees,
      atomic write (tmp + rename).

## 4. Tests
- [x] Integration: new (non-node) file edit → node + outgoing edge added.
- [x] Integration: real `unlink` of a target → node + edges removed, importer node remains.
- [x] E2E (`analyze → watch → get_file_dependencies`): deletion removes a file as importer + its node;
      creation makes a new file's imports visible. (Plus the existing modify + HTML e2e.)
- [x] Existing watcher unit + integration suites pass (coalescing restructure).

## 5. Out of scope (documented)
- [ ] New-file incoming edges (importers refresh on touch / full analyze).
- [ ] Global dep-graph metrics incremental.
- [ ] EdgeStore file-hash cleanup on delete (harmless).
