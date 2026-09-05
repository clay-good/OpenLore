/**
 * Stamp-keyed caches for the analysis artifacts a serving process reads repeatedly.
 *
 * The artifacts under `.openlore/analysis/` are written by OTHER processes —
 * `openlore analyze`, `openlore generate`, the watcher's own flush. A cache keyed on
 * the project directory alone therefore goes stale silently and stays stale for the
 * whole lifetime of a daemon. Every cache here keys on an identity stamp of the file
 * it holds, so an external rewrite is picked up on the next read and an unchanged
 * artifact is parsed exactly once.
 *
 * Deliberately its own module rather than part of `utils.ts`: `utils.ts` is mocked
 * wholesale by most handler tests, and a shared read path should not depend on every
 * one of those mocks listing it.
 *
 * (spec: ServingCachesInvalidateOnExternalAnalyze, change: optimize-serving-hot-path-caches)
 */

import { open, stat } from 'node:fs/promises';

/**
 * Identity stamp of an on-disk artifact — `dev:ino:mtimeNs:size`, or `null` when the
 * file is absent or unreadable.
 *
 * `mtimeNs` (not `mtimeMs`) is what makes the stamp usable when a file is rewritten
 * twice inside the same millisecond, and `dev`/`ino` catch an atomic tmp-file rename
 * that lands carrying an older mtime.
 */
export async function artifactStamp(path: string): Promise<string | null> {
  try {
    const s = await stat(path, { bigint: true });
    return `${s.dev}:${s.ino}:${s.mtimeNs}:${s.size}`;
  } catch {
    return null;
  }
}

/**
 * Ceiling on a sibling artifact before it is deserialized.
 *
 * These artifacts are repository-controlled input. Real ones are single-digit
 * megabytes; the cap exists so a poisoned or runaway file fails closed instead of
 * being parsed and then RETAINED for the process lifetime, which is what a cache
 * makes newly dangerous. Deliberately lower than the analysis artifact's own ceiling:
 * nothing routed through here is the multi-hundred-megabyte call graph.
 */
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

const _jsonArtifactCache = new Map<string, { stamp: string; value: unknown }>();

/**
 * Cap on distinct cache entries. Entries are keyed by absolute artifact path, so the
 * key space is bounded by the number of project directories a single server has been
 * asked about — small in practice, but a caller-supplied directory means it is not
 * bounded by construction. Oldest-first eviction (Map preserves insertion order) keeps
 * a long-lived daemon from growing without limit; an evicted entry costs one re-parse.
 */
const MAX_JSON_ARTIFACT_ENTRIES = 64;

/**
 * Read-and-parse a JSON artifact at most once per version of that artifact.
 *
 * `derive` runs only on a stamp miss; its result is cached against the stamp of the
 * bytes that produced it. A parse failure (or a missing file) caches nothing and
 * returns `null`, so a half-written artifact is retried rather than pinned.
 *
 * `derivationKey` namespaces the entry: two callers deriving DIFFERENT shapes from the
 * same file must not read each other's cached value. Derived values are shared across
 * callers and MUST be treated as read-only.
 */
export async function readJsonArtifactCached<T>(
  path: string,
  derivationKey: string,
  derive: (parsed: unknown) => T | null,
): Promise<T | null> {
  const key = `${derivationKey}\0${path}`;
  const stamp = await artifactStamp(path);
  if (stamp === null) {
    _jsonArtifactCache.delete(key);
    return null;
  }
  const cached = _jsonArtifactCache.get(key);
  if (cached && cached.stamp === stamp) return cached.value as T | null;

  let value: T | null;
  try {
    // Size-check and read through ONE descriptor. A path-based stat followed by a
    // path-based read would let the file be swapped between them, so the check would
    // not describe the bytes actually parsed.
    const handle = await open(path, 'r');
    try {
      const { size } = await handle.stat();
      if (size > MAX_ARTIFACT_BYTES) {
        _jsonArtifactCache.delete(key);
        return null;
      }
      value = derive(JSON.parse(await handle.readFile('utf-8')) as unknown);
    } finally {
      await handle.close();
    }
  } catch {
    _jsonArtifactCache.delete(key);
    return null;
  }
  // Re-stamp after the read: if the file was rewritten between the stat and the read,
  // the entry is stored under the stamp of what was actually parsed, so the next call
  // misses rather than serving bytes attributed to the wrong version.
  const readStamp = await artifactStamp(path);
  if (readStamp === null) {
    _jsonArtifactCache.delete(key);
    return value;
  }
  _jsonArtifactCache.delete(key);
  _jsonArtifactCache.set(key, { stamp: readStamp, value });
  while (_jsonArtifactCache.size > MAX_JSON_ARTIFACT_ENTRIES) {
    const oldest = _jsonArtifactCache.keys().next();
    if (oldest.done) break;
    _jsonArtifactCache.delete(oldest.value);
  }
  return value;
}

/** Test-only: drop every stamp-keyed sibling-artifact entry. */
export function _resetJsonArtifactCacheForTesting(): void {
  _jsonArtifactCache.clear();
}

/** Test-only: how many artifacts the sibling-artifact cache currently holds. */
export function _jsonArtifactCacheSizeForTesting(): number {
  return _jsonArtifactCache.size;
}

/**
 * The parsed `dependency-graph.json` for a project, or `null` when it is absent or
 * structurally unusable.
 *
 * One shared entry point rather than two call-site derivations, because two callers
 * caching different derivations of the SAME repo-sized artifact would retain two
 * copies of it — and, worse, would disagree about validation: whichever ran first
 * would decide whether the other saw a shape-checked graph or a raw one. A
 * valid-but-partial artifact (`{}`, or an interrupted analyze) parses fine but has no
 * `nodes`/`edges` arrays, so it is rejected here for every caller.
 *
 * The returned object is SHARED and must be treated as read-only.
 * (change: optimize-serving-hot-path-caches)
 */
export async function readDependencyGraphCached<T>(path: string): Promise<T | null> {
  return readJsonArtifactCached<T>(path, 'dependency-graph', (parsed) => {
    if (!parsed || typeof parsed !== 'object') return null;
    const g = parsed as { nodes?: unknown; edges?: unknown };
    if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;
    return parsed as T;
  });
}
