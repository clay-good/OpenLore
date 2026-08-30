/**
 * Periodic compaction for the LanceDB-backed search indexes (change: bulletproof-background-index).
 *
 * Every incremental update is a `delete` + `add`, and LanceDB is append-only and versioned: each
 * one leaves the previous version and its data fragments on disk. Nothing reclaimed them. A full
 * `analyze` happens to clean up — it rebuilds the directory from scratch — but a machine that just
 * leaves the watcher running never gets there, which is exactly the "always on in the background"
 * case this tool is meant for.
 *
 * Measured on a real working repository whose SOURCE is about 9 MB, after a few weeks of watching:
 *
 * | index             | on disk | live rows | versions | after compaction |
 * |-------------------|---------|-----------|----------|------------------|
 * | `text-line-index` | 401 MB  | 234,267   | 953      | 36 MB            |
 * | `vector-index`    |  62 MB  |   8,372   | 952      | 14 MB            |
 *
 * Roughly 90% of what the tool had written was reclaimable garbage, and it grows without bound.
 *
 * Two deliberate choices:
 *
 *  - Compaction runs on a COUNTER, not every update. It costs a few hundred milliseconds on the
 *    indexes above, which is fine occasionally and is not fine on every keystroke-save.
 *  - Old versions are kept for {@link VERSION_GRACE_MS} rather than dropped outright. A reader
 *    that opened the table a moment ago is still pinned to the version it opened; `cleanupOlderThan:
 *    new Date()` would delete the files out from under it. The current version is never removed by
 *    LanceDB regardless, so the grace window only protects concurrent readers.
 */

/** Compact one index after this many incremental updates. */
let COMPACT_EVERY_UPDATES = 50;

/**
 * Versions younger than this are always kept, so a concurrent reader cannot be pulled out from
 * under. A cached table handle stays pinned to the version it opened, and `cleanupOlderThan:
 * new Date()` would delete those files while it is still reading them.
 *
 * An hour is generous because it costs nothing: a daemon left running accumulates versions far
 * faster than it ages out of the window, so the steady state still reclaims essentially
 * everything — it just never races a live reader.
 */
let VERSION_GRACE_MS = 60 * 60 * 1000;

/** Per-index update counter, keyed by the index's directory. */
const _updatesSinceCompaction = new Map<string, number>();

/** Minimal view of the LanceDB table surface this module needs. */
interface CompactableTable {
  optimize(options?: { cleanupOlderThan?: Date; deleteUnverified?: boolean }): Promise<unknown>;
}

/**
 * Record one incremental update against `dbPath`, and compact if enough have accumulated or the
 * update deleted at least one cadence's worth of rows/files.
 *
 * Best-effort by construction: compaction is a space optimization, never a correctness
 * requirement, so a failure is swallowed and the counter still resets. The alternative — letting
 * an optimize error surface — would turn a disk-space chore into a failed file save.
 */
export async function noteUpdateAndMaybeCompact(
  dbPath: string,
  table: CompactableTable,
  deletedRows = 0,
): Promise<boolean> {
  const next = (_updatesSinceCompaction.get(dbPath) ?? 0) + 1;
  if (next < COMPACT_EVERY_UPDATES && deletedRows < COMPACT_EVERY_UPDATES) {
    _updatesSinceCompaction.set(dbPath, next);
    return false;
  }
  _updatesSinceCompaction.set(dbPath, 0);
  try {
    await table.optimize({ cleanupOlderThan: new Date(Date.now() - VERSION_GRACE_MS) });
    return true;
  } catch {
    return false; // a full analyze still reclaims everything by rebuilding the directory
  }
}

/** Test-only: lower the threshold so a small fixture reaches it. Returns the previous value. */
export function _setCompactEveryForTesting(n: number): number {
  const previous = COMPACT_EVERY_UPDATES;
  COMPACT_EVERY_UPDATES = n;
  return previous;
}

/** Test-only: shrink the reader-safety window so a fresh fixture can be reclaimed. */
export function _setVersionGraceMsForTesting(n: number): number {
  const previous = VERSION_GRACE_MS;
  VERSION_GRACE_MS = n;
  return previous;
}

/** Test-only: forget the counters so cases cannot leak into each other. */
export function _resetCompactionCountersForTesting(): void {
  _updatesSinceCompaction.clear();
}
