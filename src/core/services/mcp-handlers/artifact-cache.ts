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

import { readFile, stat } from 'node:fs/promises';

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
    value = derive(JSON.parse(await readFile(path, 'utf-8')) as unknown);
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
