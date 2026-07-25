# Harden JSON-artifact writes: atomic rename everywhere, one lock for concurrent writers

> Status: IMPLEMENTED (2026-07-19). Both writers adopt the tree's existing `atomicWriteFile`
> (temp + fsync + rename, `src/core/decisions/atomic-store.ts`) — the bare `writeFile`s and the
> per-site inline `tmp + rename` sites are gone — and each writer's artifact-mutation section is
> fenced by a new `withAnalysisLock` (a thin analysis-directory binding of the decision store's
> lock shape in `lock.ts`, same constants). Guarded by `artifact-write-atomicity.test.ts` and the
> analysis-lock cases in `lock.test.ts`. Originally proposed:
> PROPOSED (2026-07-03, e2e audit follow-up). `llm-context.json` and its sibling analysis
> artifacts are written with plain `writeFile` — no temp-file + atomic rename — by BOTH writers
> (analyze's artifact generator and the watcher's read-patch-write persist), and the watcher can
> spawn a concurrent full `analyze --force` against the same files. A crash or overlap yields a
> torn or lost-update artifact. The tree already owns both cures: the watcher's own tmp+rename
> pattern (applied to *other* artifacts) and the decision store's cross-process lock. Apply them;
> invent nothing.

## The gap

- **The primary artifact is written non-atomically by both writers.** The artifact generator's
  `generateAndSave` writes the whole analysis set with bare `writeFile` — the `saves` array at
  `src/core/analyzer/artifact-generator.ts:313-333` covers `repo-structure` (`:314`), `SUMMARY.md`
  (`:318`), `dependencies.mermaid` (`:322`), and `llm-context.json` (`:326-332`), with more bare
  writes at `:336-379` and `:1285,1306`. The watcher's `persistContext`
  (`src/core/services/mcp-watcher.ts:713-717`) also bare-writes `llm-context.json` after a
  read-patch-write cycle. A crash mid-write leaves a truncated file; a reader mid-write sees a
  torn one.
- **The two writers can actually overlap.** The watcher self-heals a reset graph by spawning a
  detached `analyze --force` (`mcp-watcher.ts:669-673`) while it keeps running and persisting —
  a live lost-update / torn-read race on the same artifact set. No cross-process lock guards
  analysis artifacts; only the decision store has one
  (`src/core/decisions/lock.ts`, `acquireDecisionsLock` at `:31`).
- **Existing shields are partial, and the pattern already exists in-tree.** The MCP cache's shape
  guard (`src/core/services/mcp-handlers/utils.ts:327-330`) converts a torn parse into a clean
  "re-run analyze" — the reader survives, but the user still pays a re-analyze for a writer-side
  defect. EdgeStore has WAL for the DB side. And the watcher ALREADY does tmp+rename for
  `dependency-graph.json` (`mcp-watcher.ts:921-925`, comment: "Atomic write (tmp + rename) so a
  concurrent MCP read never sees a torn file") and the fingerprint file (`:976-977`, `:1111`) —
  the discipline exists and simply skipped the largest, most-read artifact on both writers.
- Cross-reference: sibling `harden-index-store-lifecycle` hardens the SQLite store
  (corruption/quarantine); this change is the JSON-artifact counterpart — together they cover the
  persistent surface.

## What changes

**Every artifact write becomes write-temp-then-rename; the analyze/watcher writer overlap is
serialized with the existing lock pattern.**

- A small `writeFileAtomic(path, data)` helper (same-directory temp file so the rename stays on
  one filesystem, hence atomic) replaces every bare `writeFile` of an analysis artifact:
  `generateAndSave`'s saves (`artifact-generator.ts:313-379`), the late writes (`:1285,1306`),
  and the watcher's `persistContext` (`mcp-watcher.ts:713-717`). The watcher's existing inline
  tmp+rename sites (`:921-925`, `:976-977`, `:1111`) migrate to the helper — one pattern, one
  home.
- The analyze artifact-write critical section and the watcher's persist take a cross-process
  advisory lock reusing the decision store's proven shape (`lock.ts`: exclusive-create lock file,
  stale-steal, bounded wait, proceed-best-effort on timeout) — instantiated for the analysis
  directory, not a new locking invention. The watcher-spawned `analyze --force` then serializes
  against the live watcher's persist instead of racing it.
- No behavior change for readers; the shape guard remains as defense in depth, it just stops
  being the primary line.

## Why this is in scope

The artifacts are the substrate's persisted memory; a torn `llm-context.json` converts a writer
race into "your index is gone, re-run analyze" — silent degradation billed to the user. The fix
is pure discipline-parity: the tree's own atomic-write pattern and its own lock, applied
uniformly. Deterministic, local-first, zero new tuning constants (lock timings are reused as
specified in `lock.ts`).

## Impact

- Files: `src/core/analyzer/artifact-generator.ts` (all artifact writes),
  `src/core/services/mcp-watcher.ts` (`persistContext` + migrate inline tmp+rename sites), the
  `writeFileAtomic` helper's home, a thin analysis-directory instantiation of the `lock.ts`
  pattern; crash/overlap tests.
- Specs: `architecture` — 2 ADDED requirements (ArtifactWritesAreAtomic,
  ConcurrentArtifactWritersSerialize), alongside sibling `harden-index-store-lifecycle`'s deltas.
- Tool surface: unchanged (no MCP change; readers see complete artifacts more often, never a new
  shape).
- Risk: low. Rename-over is POSIX-atomic on the same filesystem (the same-directory temp
  guarantees that); Windows rename-over-existing is handled by the helper (unlink-then-rename
  fallback) and covered by tests. Lock contention worst case is the existing bounded wait.
