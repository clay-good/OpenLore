# A branch switch grinds through the per-file incremental pipeline with no bulk fallback, reloading the full node table once per changed file

> Status: PROPOSED (2026-07-03, e2e audit pass 4, scale track). The watcher's incremental path
> is right-sized for a handful of saved files and catastrophic for a bulk change (a branch
> switch, a rebase, a large pull). It reloads the entire node table once *per changed file*,
> re-parses each file's caller closure with no dedup across the batch, and never falls back to
> a single full re-analyze — so a 10k-file switch does hours of silent grinding where
> `analyze --force` takes minutes, emitting only a final one-line summary. Cold-start
> bootstrap has the mirror problem: it runs the full index build inside the MCP server's event
> loop. Distinct from `add-incremental-early-cutoff` (no-op-fact edits) and the shipped
> converge-or-flag staleness work.

## The gap

- **(a) Full node table reloaded per changed file.** `getAllInternalNodes()` (a
  `SELECT * FROM nodes WHERE is_external=0` with full row→object materialization,
  `edge-store.ts:472-476`) is called *inside* the per-file loop (`mcp-watcher.ts:477`, loop at
  `:465`) to seed cross-file resolution. On a 50k-function repo × a 10k-file batch that is
  ~500M row→object conversions before any parsing.
- **(b) No bulk fallback; caller closures not deduped.** `isBulk` is computed
  (`mcp-watcher.ts:629`, `WATCH_BULK_THRESHOLD=25`) but used only to reword the summary log
  (`:643`). Per file the watcher re-parses the file plus up to 40 caller files
  (`:483-489`, doubled when symbols were added, `:529`), with no dedup across the batch (a file
  that is a caller of 20 batch members is re-parsed ~21×), and never delegates to the existing
  `scheduleBackgroundRebuild()` full-analyze lane. The VCS settle (`:368-375`) resets only
  `debounceTimer`, not `maxBatchTimer` (2s), so a slow checkout splits into several partial
  batches each re-paying the cost.
- **(c) Cold-start bootstrap runs the full build in the server event loop.** `mcp.ts:2444-2452`
  fires the index build as an un-awaited in-process promise (tree-sitter parsing is synchronous
  CPU work), and `mcp.ts:2460` awaits the watcher's initial scan before the first tool call —
  minutes of event-loop contention + analyzer heap inside the server during first-run
  onboarding. The schema-rebuild path already spawns `openlore analyze` as a child process; the
  bootstrap should too.
- **(d) Batch content retained for the whole flush.** The watcher holds all batch file contents
  across the flush (`mcp-watcher.ts:431-445`) and never nulls `lastEmbedContext` after the
  embed lane drains (`:727-760`) — ~100MB of source strings for a large batch, plus a pinned
  context object.

## What changes

1. **Hoist the node load out of the per-file loop** — load once before the loop, patch it in
   memory per file.
2. **Add a bulk-batch fallback:** above a batch-size threshold, mark the changed files stale and
   delegate to `scheduleBackgroundRebuild()` (a single full analyze), disclosing the mode
   switch; dedup batch members out of each other's caller closures; clear `maxBatchTimer` on VCS
   events so a checkout coalesces into one batch.
3. **Move cold-start bootstrap off the event loop** — spawn `openlore analyze` as a child
   process (as the schema-rebuild path does) and start the watcher un-awaited.
4. **Release batch content as consumed** and clear `lastEmbedContext` on drain.

## Why this is in scope

Watch mode is the substrate's steady-state contract with an active agent; an incremental path
that degrades to hours on a routine branch switch — silently, with no fallback — makes the
warm daemon unusable at the scale OpenLore claims to serve, and the cold-start contention
directly harms the zero-interaction onboarding shipped in PR #216.

## Impact

- Files: `src/core/services/mcp-watcher.ts` (hoist, bulk fallback, dedup, timer, content
  release), `src/cli/commands/mcp.ts` (child-process bootstrap, un-awaited watcher start),
  `src/core/services/cold-start-bootstrap.ts`.
- Specs: `analyzer` — 1 ADDED (BulkChangesFallBackToOneRebuild); `architecture` — 1 ADDED
  (ColdStartBuildRunsOffTheServerEventLoop).
- No new tool. Risk: medium — the bulk fallback changes the incremental/rebuild boundary; the
  disclosed mode switch keeps it honest, and the converge-or-flag staleness guarantee must be
  preserved across the boundary. Verify with a synthetic large batch: node table loaded ≤1×,
  a >threshold batch delegates to one rebuild, and no file is left silently stale.
