/**
 * Peer change notices: a peer changed a symbol this agent declared it reads
 * (change: add-peer-change-notices).
 *
 * Computed from the peer footprint board, not from messages: for each symbol in the read-set an
 * agent of this worktree declared (`declare_footprint`), each live peer's worktree is checked. The
 * symbol counts as changed by the peer only when the peer's own base commit still had the text this
 * agent declared, and the peer's working tree no longer does — so a peer that merely branched from
 * an older version is not blamed for a difference it did not make. Read-only; a neutral fact for the
 * after-tools hook.
 */

import { relative, isAbsolute, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { readFileConfined } from '../../utils/path-confinement.js';
import { readBlobsAtRef, readBlobsPerFile } from '../../utils/git-blobs.js';
import { symbolHash, type BoardEntry, type BoardSymbol } from './footprint-board.js';

const MAX_READS = 200;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

export interface PeerChangeNotice {
  symbol: string;
  file: string;
  peer: { actorId: string; worktree: string; branch: string };
  /** When this agent declared reading the symbol. */
  declaredAt: string;
}


/** Whether `text` still holds the declared symbol (at its span, or wherever its head now appears). */
function holds(text: string, s: BoardSymbol): boolean {
  if (s.hash === undefined || s.start === undefined || s.end === undefined) return true; // nothing to compare: never a notice
  if (symbolHash(text.slice(s.start, s.end)) === s.hash) return true;
  if (!s.head) return false;
  const len = s.end - s.start;
  for (let at = text.indexOf(s.head), tries = 0; at !== -1 && tries < 64; at = text.indexOf(s.head, at + 1), tries++) {
    if (symbolHash(text.slice(at, at + len)) === s.hash) return true;
  }
  return false;
}

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

  const notices: PeerChangeNotice[] = [];
  const seen = new Set<string>();
  for (const me of mine) {
    // Symbol files are relative to the analysis root, which may sit below the worktree's top.
    const rootRel = relative(await real(me.worktree), await real(me.root ?? me.worktree));
    if (rootRel.startsWith('..') || isAbsolute(rootRel)) continue;
    const prefix = rootRel ? `${rootRel.split('\\').join('/')}/` : '';
    for (const read of me.reads.slice(0, MAX_READS)) {
      if (read.hash === undefined) continue;
      for (const peer of peers) {
        const key = `${peer.actorId}\0${read.file}\0${read.name}`;
        if (seen.has(key)) continue;
        const peerRoot = join(peer.worktree, rootRel);
        let now: string;
        try { now = await readFileConfined(peerRoot, read.file, MAX_FILE_BYTES); } catch { continue; } // not in the peer's tree: not its edit
        if (holds(now, read)) continue;
        // Attributable to the peer only when its base still had the declared text.
        if (!peer.baseAtDeclare) continue;
        const repoPath = `${prefix}${read.file}`;
        const blobs = await readBlobsAtRef(peer.worktree, peer.baseAtDeclare, [repoPath]).catch(() => readBlobsPerFile(peer.worktree, peer.baseAtDeclare!, [repoPath]));
        const base = blobs.get(repoPath);
        if (base === undefined || !holds(base, read)) continue;
        seen.add(key);
        notices.push({ symbol: read.name, file: read.file, peer: { actorId: peer.actorId, worktree: peer.worktree, branch: peer.branch }, declaredAt: me.declaredAt });
      }
    }
  }
  return notices;
}
