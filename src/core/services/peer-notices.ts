/**
 * Peer change notices: a peer changed a symbol this worktree's agent declared it reads
 * (change: add-peer-change-notices).
 *
 * Computed from the peer footprint board, not from messages: for each symbol in the read-set an
 * agent of this worktree declared (`declare_footprint`), each live peer's worktree is checked. The
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
import { symbolHash, type BoardEntry, type BoardSymbol } from './footprint-board.js';

/** Read × peer comparisons per call: the hook runs on every tool call. */
const MAX_CHECKS = 400;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface PeerChangeNotice {
  /** The declared symbol's id (file and name). */
  id: string;
  symbol: string;
  file: string;
  peer: { actorId: string; worktree: string; branch: string };
  /** When the read-set was declared. */
  declaredAt: string;
}

/** Whether `text` still holds the declared symbol (at its span, or wherever its head now appears). */
function holdsExactly(text: string, s: BoardSymbol): boolean {
  if (symbolHash(text.slice(s.start, s.end)) === s.hash) return true;
  if (!s.head) return false;
  const len = s.end! - s.start!;
  for (let at = text.indexOf(s.head), tries = 0; at !== -1 && tries < 64; at = text.indexOf(s.head, at + 1), tries++) {
    if (symbolHash(text.slice(at, at + len)) === s.hash) return true;
  }
  return false;
}

/** A committed blob holds the symbol as checked out: git stores LF, a CRLF checkout hashed CRLF. */
const blobHolds = (blob: string, s: BoardSymbol) => holdsExactly(blob, s) || (!blob.includes('\r') && holdsExactly(blob.replace(/\n/g, '\r\n'), s));

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

/** The symbols this worktree's agents declared reading that a live peer has since changed. */
export async function peerChangeNotices(root: string): Promise<PeerChangeNotice[]> {
  const { readBoard, worktreeIdentity } = await import('./footprint-board.js');
  const board = await readBoard(root);
  if (board.live.length < 2) return [];
  const here = await realpath((await worktreeIdentity(root)).worktree).catch(() => undefined);
  if (!here) return [];
  const real = async (p: string) => realpath(p).catch(() => p);
  const mine: BoardEntry[] = [];
  const peers: BoardEntry[] = [];
  for (const { entry } of board.live) ((await real(entry.worktree)) === here ? mine : peers).push(entry);
  if (!mine.length || !peers.length) return [];

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
  for (const me of mine) {
    // Symbol files are relative to the analysis root, which may sit below the worktree's top.
    const rootRel = relative(await real(me.worktree), await real(me.root ?? me.worktree));
    if (rootRel.startsWith('..') || isAbsolute(rootRel)) continue;
    const prefix = rootRel ? `${rootRel.split('\\').join('/')}/` : '';
    for (const read of me.reads) {
      if (read.hash === undefined || read.start === undefined || read.end === undefined) continue; // nothing to compare
      for (const peer of peers) {
        if (!peer.baseAtDeclare) continue; // no base to attribute a change with
        const key = `${peer.actorId}\0${read.id}`;
        if (seen.has(key)) continue;
        if (++checks > MAX_CHECKS) return notices;
        const now = await peerFile(peer, join(peer.worktree, rootRel), read.file);
        if (now === null || (now && holdsExactly(now, read))) continue;
        // Attributable to the peer only when its bases still had the declared text.
        const blobs = await bases(peer, `${prefix}${read.file}`);
        if (!blobs || !blobs.every(b => blobHolds(b, read))) continue;
        seen.add(key);
        notices.push({ id: read.id, symbol: read.name, file: read.file, peer: { actorId: peer.actorId, worktree: peer.worktree, branch: peer.branch }, declaredAt: me.declaredAt });
      }
    }
  }
  return notices;
}
