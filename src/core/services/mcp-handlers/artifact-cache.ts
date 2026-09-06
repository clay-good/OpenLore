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

import { constants } from 'node:fs';
import { lstat, open, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import {
  partialArtifactPathIfLive,
  readPartialArtifact,
  readPartialIndexStamp,
  type PartialArtifactName,
} from '../../runtime/partial-index.js';
import { notePartialIndexServed } from './partial-request.js';

/** Format an identity stamp from a stat result: `dev:ino:mtimeNs:ctimeNs:size`. */
function stampOf(s: { dev: bigint; ino: bigint; mtimeNs: bigint; ctimeNs: bigint; size: bigint }): string {
  return `${s.dev}:${s.ino}:${s.mtimeNs}:${s.ctimeNs}:${s.size}`;
}

/**
 * Identity stamp of an on-disk artifact, or `null` when it is absent or unreadable.
 *
 * `mtimeNs` (not `mtimeMs`) is what makes the stamp usable when a file is rewritten
 * twice inside the same millisecond; `dev`/`ino` catch an atomic tmp-file rename that
 * lands carrying an older mtime; `ctimeNs` catches a same-size in-place rewrite that
 * an mtime-only stamp would miss. The same fields `vector-index.ts` stamps with.
 *
 * The resolution is the filesystem's, not ours: where timestamps are coarser than the
 * interval between two writes (NTFS is the common case), two same-size rewrites inside
 * one tick are indistinguishable and the cached value is served until the next change.
 * Every writer of these artifacts goes through the atomic tmp-file-and-rename path,
 * which changes `ino`, so this is a bound on a case the repo does not produce rather
 * than on ordinary operation.
 */
export async function artifactStamp(path: string): Promise<string | null> {
  try {
    return stampOf(await stat(path, { bigint: true }));
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

const READ_CHUNK_BYTES = 64 * 1024;

/** One artifact read: its text and the stamp of the bytes actually read, or null. */
export interface StampedArtifact {
  text: string;
  stamp: string;
}

/**
 * Read an artifact through a single descriptor, bounded, with the stamp taken from
 * that same descriptor.
 *
 * Three properties the obvious `stat(path)` + `readFile(path)` form does not have:
 *
 *  - **The ceiling bounds the READ.** A prior stat only describes the file at that
 *    instant; a file that grows afterwards is still read to EOF. Reading in chunks up
 *    to `MAX_ARTIFACT_BYTES + 1` fails closed instead.
 *  - **The stamp describes the bytes returned.** A stamp re-taken from the PATH after
 *    the read is worse than no stamp at all: a writer landing in that window makes the
 *    cache store the old content under the new file's stamp, so every later call
 *    serves stale content believing it current. An `fstat` on the open descriptor,
 *    plus a pre/post identity check, cannot mis-attribute that way.
 *  - **No symlink, no special file.** A symlink committed into `.openlore/analysis/`
 *    must not redirect the read, and a FIFO must not stall the handler. `O_NOFOLLOW`
 *    is the race-free form and is what POSIX honours, but libuv does NOT implement it
 *    on Windows: there the flag is silently ignored and the link is followed. So the
 *    open is also VERIFIED afterwards — the descriptor's identity is compared against
 *    the path entry's, and a path that is a link (or resolves to a different inode
 *    than the descriptor holds) is refused. Verifying after the open rather than
 *    checking before it is what makes this sound: the bytes come from the descriptor,
 *    so an entry swapped after the open cannot redirect the read, and an entry that
 *    was already a link is caught. The `isFile` check on the descriptor rejects FIFOs
 *    and directories.
 */
/**
 * Whether the open descriptor is the very entry `path` names, rather than something a
 * link at that path pointed to.
 *
 * A comparison, not a pre-flight check: the caller already holds the descriptor it will
 * read from, so this can only ever reject a read — it cannot be raced into accepting a
 * substituted file. `lstat` describes the path entry without following it, so a link
 * reports `isSymbolicLink()`, and where a platform reports usable inode numbers a
 * mismatch catches the case regardless.
 */
async function descriptorIsThePathEntry(handle: FileHandle, path: string): Promise<boolean> {
  try {
    const entry = await lstat(path, { bigint: true });
    if (entry.isSymbolicLink()) return false;
    const held = await handle.stat({ bigint: true });
    if (entry.ino === 0n || held.ino === 0n) return true;  // platform reports no usable inode
    return entry.ino === held.ino && entry.dev === held.dev;
  } catch {
    return false;
  }
}

export async function readArtifactBounded(path: string): Promise<StampedArtifact | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.size > BigInt(MAX_ARTIFACT_BYTES)) return null;
    if (!(await descriptorIsThePathEntry(handle, path))) return null;

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_ARTIFACT_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, MAX_ARTIFACT_BYTES + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > MAX_ARTIFACT_BYTES) return null;

    // The file must not have moved underneath the read, or the stamp would describe
    // something other than what was returned.
    const after = await handle.stat({ bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) return null;

    return { text: Buffer.concat(chunks, total).toString('utf8'), stamp: stampOf(after) };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
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
