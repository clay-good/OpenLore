/**
 * The peer footprint board (change: add-peer-footprint-board).
 *
 * One small JSON file per live agent, in the clone's git common directory
 * (`<git-common-dir>/openlore/board/`), so every worktree of one clone reads the same entries with
 * no server and no network. An entry holds structured fields only — the agent's declared write-set
 * and read-set resolved to symbols (with a content hash at declaration), the symbols or files it
 * intends to create, its worktree and branch, and a short screened title.
 *
 * Entries end on evidence, never by guesswork: released, not refreshed within the panic-state
 * session expiry, worktree removed, branch deleted, or branch merged into the default branch.
 * Reads are fail-open (an unreadable entry is counted, not fatal); writes are atomic and bounded.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join, isAbsolute, resolve } from 'node:path';
import { execFileGit } from '../../utils/git-exec.js';
import { readFileConfined } from '../../utils/path-confinement.js';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { PANIC_SESSION_EXPIRY_MS } from './mcp-handlers/panic-constants.js';

/** Live entries the board holds at most. */
export const MAX_BOARD_ENTRIES = 64;
/** Bytes one entry file may hold. */
const MAX_ENTRY_BYTES = 256 * 1024;
/** Symbols per set recorded at most. */
export const MAX_SET_SYMBOLS = 200;

export interface BoardSymbol {
  id: string;
  name: string;
  file: string;
  /** Character span of the symbol in its file at declaration, and the hash of that text. */
  start?: number;
  end?: number;
  hash?: string;
}

export interface BoardEntry {
  version: 1;
  actorId: string;
  /** Absolute path of the worktree the agent works in. */
  worktree: string;
  branch: string;
  /** Screened title (≤120 chars), absent when none or withheld. */
  title?: string;
  titleWithheld?: boolean;
  /** The seeds as declared (symbol ids, names, or files). */
  writeSeeds: string[];
  readSeeds: string[];
  writes: BoardSymbol[];
  reads: BoardSymbol[];
  /** Write seeds that resolve to nothing yet: symbols or files the agent intends to create. */
  creates: string[];
  /** The declared write mode (default `modify`). */
  writeMode?: 'append' | 'modify';
  /** The branch's merge-base with the default branch at declaration. */
  baseAtDeclare?: string;
  declaredAt: string;
  lastSeenAt: string;
}

export type EndReason = 'expired' | 'worktree-removed' | 'branch-deleted' | 'branch-merged';

export interface BoardRead {
  live: Array<{ entry: BoardEntry; moved: string[] }>;
  ended: Array<{ actorId: string; reason: EndReason; file: string }>;
  /** Entry files that could not be read or parsed. */
  unreadable: number;
  boundaries: string[];
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileGit('git', args, { cwd });
  return String(stdout).trim();
}

/** The board directory of the clone `root` belongs to, or null outside a git work tree. */
export async function boardDir(root: string): Promise<string | null> {
  try {
    const common = await git(root, ['rev-parse', '--git-common-dir']);
    const abs = isAbsolute(common) ? common : resolve(root, common);
    return join(abs, 'openlore', 'board');
  } catch {
    return null;
  }
}

const fileFor = (dir: string, actorId: string) => join(dir, `${createHash('sha1').update(actorId).digest('hex').slice(0, 16)}.json`);
export const symbolHash = (text: string) => createHash('sha1').update(text).digest('hex').slice(0, 16);

export async function writeEntry(root: string, entry: BoardEntry): Promise<void> {
  const dir = await boardDir(root);
  if (!dir) throw new Error('not a git work tree: the board lives in the git common directory');
  const text = JSON.stringify(entry);
  if (Buffer.byteLength(text) > MAX_ENTRY_BYTES) throw new Error(`the entry is larger than ${MAX_ENTRY_BYTES / 1024} KB`);
  await atomicWriteFile(fileFor(dir, entry.actorId), text);
}

/** Remove an entry. Returns whether one existed. */
export async function removeEntry(root: string, actorId: string): Promise<boolean> {
  const dir = await boardDir(root);
  if (!dir) return false;
  const f = fileFor(dir, actorId);
  if (!existsSync(f)) return false;
  await rm(f, { force: true });
  return true;
}

const isEntry = (v: unknown): v is BoardEntry => {
  const e = v as Partial<BoardEntry> | null;
  return !!e && e.version === 1 && typeof e.actorId === 'string' && typeof e.worktree === 'string' && typeof e.branch === 'string'
    && Array.isArray(e.writes) && Array.isArray(e.reads) && Array.isArray(e.creates) && typeof e.lastSeenAt === 'string';
};

/** The default branch (`main`, else `master`), or null. */
async function defaultBranch(root: string): Promise<string | null> {
  for (const b of ['main', 'master']) {
    try { await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}^{commit}`]); return b; } catch { /* next */ }
  }
  return null;
}

/** Why an entry is no longer live, or null when it is. */
async function endReason(root: string, e: BoardEntry, now: number, main: string | null): Promise<EndReason | null> {
  const seen = Date.parse(e.lastSeenAt);
  if (!Number.isFinite(seen) || now - seen > PANIC_SESSION_EXPIRY_MS) return 'expired';
  if (!existsSync(e.worktree)) return 'worktree-removed';
  if (!e.branch) return null; // a detached HEAD: only expiry and release end it
  let tip: string;
  try {
    tip = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${e.branch}^{commit}`]);
  } catch {
    return 'branch-deleted';
  }
  // Merged: the branch has commits of its own, and they are now in the default branch.
  if (main && e.branch !== main && e.baseAtDeclare && tip !== e.baseAtDeclare) {
    try {
      await git(root, ['merge-base', '--is-ancestor', tip, `refs/heads/${main}`]);
      return 'branch-merged';
    } catch { /* not an ancestor */ }
  }
  return null;
}

/** Symbols whose text at their declared span no longer hashes the same in the entry's worktree. */
async function movedSymbols(e: BoardEntry): Promise<string[]> {
  const moved = new Set<string>();
  const byFile = new Map<string, BoardSymbol[]>();
  for (const s of [...e.writes, ...e.reads]) if (s.hash && s.start !== undefined && s.end !== undefined) (byFile.get(s.file) ?? byFile.set(s.file, []).get(s.file)!).push(s);
  for (const [file, syms] of byFile) {
    let text: string | null;
    try { text = await readFileConfined(e.worktree, file, 4 * 1024 * 1024); } catch { text = null; }
    for (const s of syms) if (text === null || symbolHash(text.slice(s.start, s.end)) !== s.hash) moved.add(s.name);
  }
  return [...moved].sort();
}

/**
 * Read the board. Read-only: entries that ended are listed with the reason and left for
 * {@link pruneEnded} (called by the writing tool). An unreadable entry is counted and skipped.
 */
export async function readBoard(root: string, opts: { now?: number } = {}): Promise<BoardRead> {
  const out: BoardRead = { live: [], ended: [], unreadable: 0, boundaries: [] };
  const dir = await boardDir(root);
  if (!dir) { out.boundaries.push('The board was not read: it lives in the git common directory and this is not a git work tree.'); return out; }
  let names: string[];
  try { names = (await readdir(dir)).filter(n => n.endsWith('.json')).sort(); } catch { return out; }
  const now = opts.now ?? Date.now();
  const main = await defaultBranch(root);
  for (const n of names) {
    let entry: unknown;
    try {
      const raw = await readFile(join(dir, n), 'utf-8');
      if (raw.length > MAX_ENTRY_BYTES) throw new Error('too large');
      entry = JSON.parse(raw);
    } catch { out.unreadable++; continue; }
    if (!isEntry(entry)) { out.unreadable++; continue; }
    const reason = await endReason(root, entry, now, main);
    if (reason) { out.ended.push({ actorId: entry.actorId, reason, file: join(dir, n) }); continue; }
    out.live.push({ entry, moved: await movedSymbols(entry) });
  }
  if (out.unreadable) out.boundaries.push(`${out.unreadable} board entr${out.unreadable === 1 ? 'y' : 'ies'} could not be read and ${out.unreadable === 1 ? 'was' : 'were'} skipped.`);
  if (!main) out.boundaries.push('No main or master branch: a merged branch is not detected; its entry ends when released, deleted, or expired.');
  out.boundaries.push('The board covers the worktrees of this clone only; agents in other clones or on other machines are not visible.');
  out.live.sort((a, b) => (a.entry.actorId < b.entry.actorId ? -1 : a.entry.actorId > b.entry.actorId ? 1 : 0));
  return out;
}

/** The current branch name and merge-base with the default branch, for a new entry. */
export async function worktreeIdentity(root: string): Promise<{ worktree: string; branch: string; baseAtDeclare?: string }> {
  const worktree = await git(root, ['rev-parse', '--show-toplevel']);
  let branch = '';
  try { branch = await git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']); } catch { /* detached */ }
  const main = await defaultBranch(root);
  let baseAtDeclare: string | undefined;
  if (main) { try { baseAtDeclare = await git(root, ['merge-base', 'HEAD', `refs/heads/${main}`]); } catch { /* none */ } }
  return { worktree, branch, ...(baseAtDeclare ? { baseAtDeclare } : {}) };
}

/** Live board entries as task descriptors for the coordination tools (write seeds only). */
export async function liveTaskDescriptors(root: string): Promise<Array<{ id: string; seedSymbols: string[]; writeMode?: 'append' | 'modify' }>> {
  const board = await readBoard(root);
  return board.live
    .filter(l => l.entry.writeSeeds.length > 0)
    .map(l => ({ id: l.entry.actorId, seedSymbols: l.entry.writeSeeds, ...(l.entry.writeMode ? { writeMode: l.entry.writeMode } : {}) }));
}

/** Remove the entry files of ended entries (best effort). */
export async function pruneEnded(ended: BoardRead['ended']): Promise<void> {
  for (const e of ended) await rm(e.file, { force: true }).catch(() => undefined);
}
