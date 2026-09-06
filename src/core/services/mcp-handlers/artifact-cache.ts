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
 * These artifacts are also untrusted repository content, and a cache makes that
 * sharper: what is parsed here is RETAINED. Reads therefore follow the same rules as
 * the repo's other untrusted-artifact readers (`readCorpusSidecarBounded`,
 * `readFileConfinedWithStat`) — no symlink following, regular files only, a byte
 * ceiling enforced on the READ rather than on a prior stat, and an identity check
 * taken from the same descriptor that produced the bytes.
 *
 * Deliberately its own module rather than part of `utils.ts`: `utils.ts` is mocked
 * wholesale by most handler tests, and a shared read path should not depend on every
 * one of those mocks listing it.
 *
 * Callers pass an absolute path they have already confined to a validated project
 * directory (every current one builds it as `join(await validateDirectory(dir),
 * '.openlore', 'analysis', …)`). This module does not re-derive that confinement; it
 * defends the read itself.
 *
 * (spec: ServingCachesInvalidateOnExternalAnalyze, change: optimize-serving-hot-path-caches)
 */

import { join } from 'node:path';
import {
  artifactStamp,
  readArtifactBounded,
  type StampedArtifact,
} from '../../../utils/bounded-artifact-read.js';

// Re-exported: these names are part of this module's established surface, and callers that
// already import them from here should not have to move.
export { artifactStamp, readArtifactBounded, type StampedArtifact };
import {
  partialArtifactPathIfLive,
  readPartialArtifact,
  readPartialIndexStamp,
  type PartialArtifactName,
} from '../../runtime/partial-index.js';
import { notePartialIndexServed } from './partial-request.js';

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
 * bytes that produced it. A read failure, a parse failure, an oversized file, or a
 * file that moved mid-read caches nothing and returns `null`, so a half-written
 * artifact is retried rather than pinned.
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

  const read = await readArtifactBounded(path);
  if (read === null) {
    _jsonArtifactCache.delete(key);
    return null;
  }
  let value: T | null;
  try {
    value = derive(JSON.parse(read.text) as unknown);
  } catch {
    _jsonArtifactCache.delete(key);
    return null;
  }

  _jsonArtifactCache.delete(key);
  _jsonArtifactCache.set(key, { stamp: read.stamp, value });
  while (_jsonArtifactCache.size > MAX_JSON_ARTIFACT_ENTRIES) {
    const oldest = _jsonArtifactCache.keys().next();
    if (oldest.done) break;
    _jsonArtifactCache.delete(oldest.value);
  }
  return value;
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
  return readDependencyGraphAt<T>(path);
}

/**
 * The parsed dependency graph for a project, falling back to a live partial first-run index
 * when no published one exists yet (change: refine-first-run-partial-serving).
 *
 * Ordered so a repository with a published index pays nothing: the published read runs exactly
 * as before, and only its `null` — meaning the artifact is absent or unusable — reaches for the
 * partial one. When the fallback answers, the request is marked so `dispatchTool` attaches the
 * completeness receipt; a caller can never receive these bytes without being told what they are.
 */
export async function readDependencyGraphOrPartial<T>(
  analysisDir: string,
  artifactName: string,
): Promise<T | null> {
  const published = await readDependencyGraphAt<T>(join(analysisDir, artifactName));
  if (published !== null) return published;
  // ABSENT, not merely unusable. A published artifact that is corrupt, oversized, or a symlink
  // must keep failing loudly: standing a partial index in for it would turn a problem the
  // operator needs to see into a quiet downgrade. Same policy as `readCachedContext`.
  if (await artifactStamp(join(analysisDir, artifactName)) !== null) return null;

  const stamp = await readPartialIndexStamp(analysisDir);
  if (!stamp) return null;
  const partialPath = await partialArtifactPathIfLive(analysisDir, 'dependency-graph.json');
  if (partialPath === null) return null;
  const partial = await readDependencyGraphAt<T>(partialPath);
  if (partial !== null) notePartialIndexServed(stamp);
  return partial;
}

/**
 * The raw text of one analysis artifact, falling back to a live partial index the same way.
 *
 * Used by readers that parse an artifact themselves rather than through the shared cache.
 */
export async function readAnalysisArtifactOrPartial(
  analysisDir: string,
  artifact: PartialArtifactName,
): Promise<string | null> {
  const published = await readArtifactBounded(join(analysisDir, artifact));
  if (published !== null) return published.text;
  if (await artifactStamp(join(analysisDir, artifact)) !== null) return null;

  const stamp = await readPartialIndexStamp(analysisDir);
  if (!stamp) return null;
  const text = await readPartialArtifact(analysisDir, artifact);
  if (text !== null) notePartialIndexServed(stamp);
  return text;
}

function readDependencyGraphAt<T>(path: string): Promise<T | null> {
  return readJsonArtifactCached<T>(path, 'dependency-graph', (parsed) => {
    if (!parsed || typeof parsed !== 'object') return null;
    const g = parsed as { nodes?: unknown; edges?: unknown };
    if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;
    return parsed as T;
  });
}

/** Test-only: drop every stamp-keyed sibling-artifact entry. */
export function _resetJsonArtifactCacheForTesting(): void {
  _jsonArtifactCache.clear();
}

/** Test-only: how many artifacts the sibling-artifact cache currently holds. */
export function _jsonArtifactCacheSizeForTesting(): number {
  return _jsonArtifactCache.size;
}

/** Test-only: the bounded, descriptor-stamped read behind every cached artifact. */
export const _readArtifactBoundedForTesting = readArtifactBounded;
