/**
 * The bounded, untrusted-artifact read every `.openlore/` reader in this repo is required to use.
 *
 * Extracted from `mcp-handlers/artifact-cache.ts` (change: refine-first-run-partial-serving) so
 * the analyzer, the runtime and the serving layer can all share ONE implementation. It moved
 * because a second reader needed it and reached across a layer boundary to get it — and a second
 * COPY of it is exactly how one of them ends up without the FIFO check.
 *
 * These files are written by other processes and, in the case a hostile repository ships them,
 * by an adversary. Reads therefore follow the repo's untrusted-artifact rules: no symlink
 * following, regular files only, a byte ceiling enforced on the READ rather than on a prior
 * stat, and an identity check taken from the same descriptor that produced the bytes.
 */

import { constants } from 'node:fs';
import { lstat, open, stat, type FileHandle } from 'node:fs/promises';

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
 * Default ceiling: for the SIBLING artifacts (parse health, style fingerprint, and the like).
 *
 * These are repository-controlled input. Real ones are single-digit megabytes; the cap exists so
 * a poisoned or runaway file fails closed instead of being parsed and then RETAINED for the
 * process lifetime, which is what a cache makes newly dangerous. Deliberately lower than
 * {@link ANALYSIS_ARTIFACT_MAX_BYTES}, which callers pass explicitly for the graph-sized
 * artifacts — a reader that needs the larger ceiling asks for it.
 */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

/**
 * Ceiling for the analysis artifacts themselves.
 *
 * Higher than {@link MAX_ARTIFACT_BYTES} because `llm-context.json` on a large repository is
 * legitimately hundreds of megabytes — this matches the ceiling the context reader already
 * applies. The point of bounding these at all is to fail closed on a poisoned file rather than
 * OOM, not to cap what a real analysis is allowed to produce.
 */
export const ANALYSIS_ARTIFACT_MAX_BYTES = 512 * 1024 * 1024;

const READ_CHUNK_BYTES = 64 * 1024;

/** One artifact read: its text and the stamp of the bytes actually read, or null. */
export interface StampedArtifact {
  text: string;
  stamp: string;
}

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
/**
 * Is the entry AT this path a symlink?
 *
 * Split out of {@link descriptorIsThePathEntry} because it is the half that must hold
 * even for a file being republished under the reader, and because on Windows it is the
 * only symlink refusal in the stack — `O_NOFOLLOW` is a no-op there. A path that cannot
 * be `lstat`ed is treated as a symlink, i.e. refused, since the point is to fail closed.
 */
async function pathEntryIsSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return true;
  }
}

export async function descriptorIsThePathEntry(handle: FileHandle, path: string): Promise<boolean> {
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

/**
 * Read an artifact through a single descriptor, bounded, with the stamp taken from
 * that same descriptor.
 *
 * Three properties the obvious `stat(path)` + `readFile(path)` form does not have:
 *
 * Pass `republishedConcurrently` for a file its own writer rewrites continuously (the
 * analysis progress sidecar). The identity checks exist so the returned bytes and the
 * returned stamp describe the same entry, which is the right contract for a write-once
 * artifact — but a hot file is republished by write-temp-then-rename, so those checks fail
 * as a matter of course and a caller reading "refused" as "not there" reports no analysis
 * running while one is (measured: 234 false absences in 400 reads). The option relaxes ONLY
 * the inode-identity comparison. The explicit symlink refusal, O_NONBLOCK and the
 * isFile/size ceiling still apply, so a symlink, a FIFO and an oversized file are refused
 * on every platform; the stamp is then taken from the opened descriptor, which is the entry
 * actually read.
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
 * Why a bounded read produced nothing.
 *
 * `absent` and `refused` are deliberately distinguished: a caller that treats "no such file" as
 * a legitimate state (an analysis predating manifests, say) must not treat "this file is a FIFO,
 * a symlink, or too large" the same way. Collapsing them is how a poisoned artifact gets read as
 * a missing one and quietly downgraded.
 */
export type BoundedReadResult =
  | { state: 'ok'; bytes: Buffer; stamp: string }
  | { state: 'absent' }
  | { state: 'refused' };

/** The bytes of an artifact, read under the discipline described above. */
export async function readArtifactBytesBounded(
  path: string,
  maxBytes: number = MAX_ARTIFACT_BYTES,
  options: { republishedConcurrently?: boolean } = {},
): Promise<BoundedReadResult> {
  let handle: FileHandle | undefined;
  try {
    // O_NONBLOCK as well as O_NOFOLLOW. `O_NOFOLLOW` refuses a symlink, but a FIFO is not a
    // symlink: opening one read-only BLOCKS INSIDE `open()` until a writer appears, before any
    // `isFile()` check can run. That block happens on a libuv threadpool worker, which
    // `process.exit` cannot interrupt — a hostile repository shipping a FIFO under `.openlore/`
    // could hang a tool call permanently AND stop the server from shutting down. On a regular
    // file O_NONBLOCK is a no-op; on a FIFO it returns immediately and `isFile()` then refuses.
    // (`O_NONBLOCK` is absent on Windows, where these flags are emulated; `?? 0` keeps the open
    // unchanged there, and the `isFile()` refusal still applies.)
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    // ENOENT is absence. ELOOP (a symlink, refused by O_NOFOLLOW) and everything else are a
    // refusal: the entry exists and is not something this reader will follow.
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent' } : { state: 'refused' };
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.size > BigInt(maxBytes)) return { state: 'refused' };
    // Two DIFFERENT properties live in `descriptorIsThePathEntry`, and a republishing
    // writer only invalidates one of them.
    //
    //  - "the path is not a symlink" is stable, and on Windows it is the ONLY symlink
    //    defense there is: O_NOFOLLOW is a documented no-op on that platform, so the
    //    open above happily follows a link. Skipping this check there followed a
    //    committed symlink and served the target's bytes — caught by the Windows job.
    //    It is therefore always enforced.
    //  - "the descriptor is still the entry at that path" is an identity/stability
    //    check. A file republished by write-temp-then-rename fails it as a matter of
    //    course, which is what turned a normal concurrent rename into a reported
    //    ABSENCE. Only that half is relaxed.
    if (await pathEntryIsSymlink(path)) return { state: 'refused' };
    if (!options.republishedConcurrently
      && !(await descriptorIsThePathEntry(handle, path))) return { state: 'refused' };

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) return { state: 'refused' };

    // The file must not have moved underneath the read, or the stamp would describe
    // something other than what was returned.
    if (options.republishedConcurrently) {
      return { state: 'ok', bytes: Buffer.concat(chunks, total), stamp: stampOf(opened) };
    }
    const after = await handle.stat({ bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size
      || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) return { state: 'refused' };

    return { state: 'ok', bytes: Buffer.concat(chunks, total), stamp: stampOf(after) };
  } catch {
    return { state: 'refused' };
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function readArtifactBounded(
  path: string,
  maxBytes: number = MAX_ARTIFACT_BYTES,
): Promise<StampedArtifact | null> {
  const read = await readArtifactBytesBounded(path, maxBytes);
  return read.state === 'ok' ? { text: read.bytes.toString('utf8'), stamp: read.stamp } : null;
}
