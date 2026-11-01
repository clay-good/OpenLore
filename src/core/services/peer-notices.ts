/**
 * Peer change notices: a peer changed a symbol this worktree's agent declared it reads, or was
 * recently served by `orient` or `recall` (changes: add-peer-change-notices,
 * add-peer-notices-served-set-and-fleet-records).
 *
 * Computed from the peer footprint board, not from messages: for each symbol in the read-set an
 * agent of this worktree declared (`declare_footprint`), and each function a lease token issued in
 * this worktree within {@link SERVED_WINDOW_MS} names, each live peer's worktree is checked. The
 * symbol counts as changed by the peer only when the peer's base commits — at declaration and now —
 * still had the declared text, and the peer's working tree no longer does. So a peer that merely
 * branched from an older version, or rebased onto someone else's change, is not blamed for a
 * difference it did not make. Read-only; a neutral fact for the after-tools hook.
 */

import { relative, isAbsolute, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { readFileConfined } from '../../utils/path-confinement.js';
import { readBlobsAtRef, readBlobsPerFile } from '../../utils/git-blobs.js';
import { execFileGit } from '../../utils/git-exec.js';
import { symbolHash, type BoardEntry } from './footprint-board.js';
import { PANIC_SESSION_EXPIRY_MS } from './mcp-handlers/panic-constants.js';

/** Read × peer comparisons per call: the hook runs on every tool call. */
const MAX_CHECKS = 400;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Served functions count for as long as a board entry stays live without a refresh. */
export const SERVED_WINDOW_MS = PANIC_SESSION_EXPIRY_MS;

/** A symbol this worktree read: its span, its text hash (and the hash function), and how and when it was read. */
interface ReadSymbol {
  id: string; name: string; file: string; start: number; end: number; hash: string; head?: string;
  hashOf: (text: string) => string;
  via: 'declared' | 'served';
  at: string;
  /** The analysis root relative to the worktree top ('' at the top), and its repository-path prefix. */
  rootRel: string; prefix: string;
}

export interface PeerChangeNotice {
  /** The symbol's id (file and name). */
  id: string;
  symbol: string;
  file: string;
  /** Where the symbol began when it was read (tells same-name symbols in one file apart). */
  start: number;
  peer: { actorId: string; worktree: string; branch: string };
  /** How this worktree read it: a declared read-set, or served by `orient` or `recall`. */
  via: 'declared' | 'served';
  /** When the read-set was declared, or when it was served. */
  at: string;
}

/** Whether `text` still holds the declared symbol (at its span, or wherever its head now appears). */
function holdsExactly(text: string, s: ReadSymbol): boolean {
  if (s.hashOf(text.slice(s.start, s.end)) === s.hash) return true;
  if (!s.head) return false;
  const len = s.end - s.start;
  for (let at = text.indexOf(s.head), tries = 0; at !== -1 && tries < 64; at = text.indexOf(s.head, at + 1), tries++) {
    if (s.hashOf(text.slice(at, at + len)) === s.hash) return true;
  }
  return false;
}

/** A committed blob holds the symbol as checked out: git stores LF, a CRLF checkout hashed CRLF. */
const blobHolds = (blob: string, s: ReadSymbol) => holdsExactly(blob, s) || (!blob.includes('\r') && holdsExactly(blob.replace(/\n/g, '\r\n'), s));

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

/** The symbols this worktree's agents declared reading, or were served, that a live peer has since changed. */
export async function peerChangeNotices(root: string): Promise<PeerChangeNotice[]> {
  const { readBoard, worktreeIdentity } = await import('./footprint-board.js');
  const board = await readBoard(root);
  if (!board.live.length) return [];
  const here = await realpath((await worktreeIdentity(root)).worktree).catch(() => undefined);
  if (!here) return [];
  const real = async (p: string) => realpath(p).catch(() => p);
  const mine: BoardEntry[] = [];
  const peers: BoardEntry[] = [];
  for (const { entry } of board.live) ((await real(entry.worktree)) === here ? mine : peers).push(entry);
  if (!peers.length) return [];

  const rootPrefix = (rootRel: string) => (rootRel ? `${rootRel.split('\\').join('/')}/` : '');
  const reads: ReadSymbol[] = [];
  for (const me of mine) {
    // Symbol files are relative to the analysis root, which may sit below the worktree's top.
    const rootRel = relative(await real(me.worktree), await real(me.root ?? me.worktree));
    if (rootRel.startsWith('..') || isAbsolute(rootRel)) continue;
    for (const r of me.reads) {
      if (r.hash === undefined || r.start === undefined || r.end === undefined) continue; // nothing to compare
      reads.push({ id: r.id, name: r.name, file: r.file, start: r.start, end: r.end, hash: r.hash, head: r.head, hashOf: symbolHash, via: 'declared', at: me.declaredAt, rootRel, prefix: rootPrefix(rootRel) });
    }
  }
  try {
    const { recentServedFunctions, leaseTextHash } = await import('./lease-tokens.js');
    const rootRel = relative(here, await real(root));
    if (!rootRel.startsWith('..') && !isAbsolute(rootRel)) {
      for (const f of await recentServedFunctions(root, SERVED_WINDOW_MS)) {
        reads.push({ id: `${f.file}::${f.name}`, name: f.name, file: f.file, start: f.start, end: f.end, hash: f.hash, head: f.head, hashOf: leaseTextHash, via: 'served', at: f.servedAt, rootRel, prefix: rootPrefix(rootRel) });
      }
    }
  } catch { /* no tokens */ }
  if (!reads.length) return [];

  // Per peer: its working-tree files and its base blobs, read once per call.
  const peerText = new Map<string, Promise<string | null>>();
  const baseBlobs = new Map<string, Promise<string[] | null>>();
  const currentBase = new Map<string, Promise<string | null>>();
  const peerFile = (peer: BoardEntry, peerRoot: string, file: string) => {
    const k = `${peer.actorId}\0${file}`;
    if (!peerText.has(k)) {
      peerText.set(k, readFileConfined(peerRoot, file, MAX_FILE_BYTES)
        // Deleted by the peer: the declared text is gone. Any other failure: nothing to compare.
        .catch(e => (isMissing(e) ? '' : null)));
    }
    return peerText.get(k)!;
  };
  const peerBase = (peer: BoardEntry) => {
    if (!currentBase.has(peer.actorId)) {
      currentBase.set(peer.actorId, (async () => {
        try {
          const { stdout } = await execFileGit('git', ['merge-base', 'HEAD', 'refs/heads/main'], { cwd: peer.worktree });
          return String(stdout).trim() || null;
        } catch {
          try {
            const { stdout } = await execFileGit('git', ['merge-base', 'HEAD', 'refs/heads/master'], { cwd: peer.worktree });
            return String(stdout).trim() || null;
          } catch { return null; }
        }
      })());
    }
    return currentBase.get(peer.actorId)!;
  };
  /** The file at the peer's base at declaration and its base now (one or two blobs), or null when unreadable. */
  const bases = (peer: BoardEntry, repoPath: string) => {
    const k = `${peer.actorId}\0${repoPath}`;
    if (!baseBlobs.has(k)) {
      baseBlobs.set(k, (async () => {
        const refs = [peer.baseAtDeclare!];
        const now = await peerBase(peer);
        if (now && now !== peer.baseAtDeclare) refs.push(now);
        const out: string[] = [];
        for (const ref of refs) {
          const blobs = await readBlobsAtRef(peer.worktree, ref, [repoPath]).catch(() => readBlobsPerFile(peer.worktree, ref, [repoPath]));
          const b = blobs.get(repoPath);
          if (b === undefined) return null;
          out.push(b);
        }
        return out;
      })());
    }
    return baseBlobs.get(k)!;
  };

  const notices: PeerChangeNotice[] = [];
  const seen = new Set<string>();
  let checks = 0;
  for (const read of reads) {
    for (const peer of peers) {
      if (!peer.baseAtDeclare) continue; // no base to attribute a change with
      // One notice per peer and symbol; a declared read comes first and wins over the same served one.
      const key = `${peer.actorId}\0${read.file}\0${read.name}\0${read.start}`; // start: same-name symbols in one file differ
      if (seen.has(key)) continue;
      if (++checks > MAX_CHECKS) return notices;
      const now = await peerFile(peer, join(peer.worktree, read.rootRel), read.file);
      if (now === null || (now && holdsExactly(now, read))) continue;
      // Attributable to the peer only when its bases still had the text this worktree read.
      const blobs = await bases(peer, `${read.prefix}${read.file}`);
      if (!blobs || !blobs.every(b => blobHolds(b, read))) continue;
      seen.add(key);
      notices.push({ id: read.id, symbol: read.name, file: read.file, start: read.start, peer: { actorId: peer.actorId, worktree: peer.worktree, branch: peer.branch }, via: read.via, at: read.at });
    }
  }
  return notices;
}
