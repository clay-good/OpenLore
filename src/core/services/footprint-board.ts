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
 *
 * The end predicates are the clone's single lifecycle decider ({@link judgeLifecycle}), so anything
 * else recorded per branch and worktree — the fleet verification records next door — ends on the
 * same evidence rather than on a copy of these rules. A subject that does not carry what a
 * predicate needs reports that predicate `unknown`; a missing field never means "ended".
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, realpath, rm } from 'node:fs/promises';
import { join, isAbsolute, resolve, dirname, basename, relative } from 'node:path';
import { execFileGit } from '../../utils/git-exec.js';
import { readFileConfined } from '../../utils/path-confinement.js';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { PANIC_SESSION_EXPIRY_MS } from './mcp-handlers/panic-constants.js';

/** Live entries the board holds at most. */
export const MAX_BOARD_ENTRIES = 64;
/** Board files read at most per read. */
const MAX_FILES_READ = 512;
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
  /** The symbol's first characters, to find it again after edits above it. */
  head?: string;
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
  /** Existing files with no symbols that the agent will write. */
  fileWrites?: string[];
  /** The analysis root the symbol paths are relative to (default: the worktree). */
  root?: string;
  /** The declared write mode (default `modify`). */
  writeMode?: 'append' | 'modify';
  /** The branch's merge-base with the default branch at declaration. */
  baseAtDeclare?: string;
  declaredAt: string;
  lastSeenAt: string;
}

export type EndReason = 'expired' | 'worktree-removed' | 'branch-deleted' | 'branch-merged';

/**
 * Why a predicate could not be evaluated. A predicate the subject does not carry the evidence for
 * is reported here and skipped — never resolved as "ended" by the absence of a field.
 */
export type LifecycleUnknown =
  | 'expiry-unknown-no-timestamp'
  | 'worktree-unknown-not-recorded'
  | 'branch-unknown-detached-or-unrecorded'
  | 'branch-unknown-unusable-name'
  | 'branch-unknown-git-could-not-be-asked'
  | 'branch-unknown-never-a-known-branch'
  | 'branch-merged-unknown-no-default-branch'
  | 'branch-merged-unknown-no-base-commit';

/** What the lifecycle predicates read. Every field is optional: an absent one is `unknown`. */
export interface LifecycleSubject {
  /** When the subject was last refreshed (ISO). Absent → the idle-expiry predicate is unknown. */
  lastSeenAt?: string;
  /** The worktree top this subject belongs to. Absent → it is not matched against the clone's worktrees. */
  worktree?: string;
  /** The directory the subject's paths are relative to; must exist, and sit inside `worktree`. */
  root?: string;
  /** The branch. Empty or absent → a detached HEAD, or not recorded. */
  branch?: string;
  /**
   * Evidence that `branch` really named a local branch when the subject was recorded. Without it a
   * name absent from the clone's branches proves nothing — it may be a task id that never was a
   * branch — so the branch predicates report unknown instead of "deleted".
   */
  branchKnownRef?: boolean;
  /** The merge-base with the default branch when the subject was recorded. A commit id only. */
  baseAtDeclare?: string;
}

/** A lifecycle verdict for one subject: why it ended (or null), and the predicates left unknown. */
export interface LifecycleVerdict {
  reason: EndReason | null;
  unknown: LifecycleUnknown[];
}

/** A commit id, never an option or a revision expression: it is passed to git. */
const COMMIT_ID_RE = /^[0-9a-f]{40,64}$/;
/**
 * A branch name this decider will hand to git. Bounded and free of control characters, so a
 * peer-written 128 KB or newline-bearing name is reported unknown instead of spawned. No real
 * branch name is rejected (git itself forbids control characters and spaces in a refname).
 */
const MAX_BRANCH_CHARS = 512;
const usableBranch = (b: string): boolean => {
  if (!b.length || b.length > MAX_BRANCH_CHARS) return false;
  for (let i = 0; i < b.length; i++) { const c = b.charCodeAt(i); if (c < 0x20 || c === 0x7f) return false; }
  return !/[\s~^:?*[\\]/.test(b);
};

export interface BoardRead {
  live: Array<{ entry: BoardEntry; moved: string[] }>;
  ended: Array<{ actorId: string; reason: EndReason; file: string; lastSeenAt: string }>;
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
    // Canonical: a symlinked path (macOS /var → /private/var) would fail the confined reads.
    return join(await realpath(abs).catch(() => abs), 'openlore', 'board');
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

const isSymbol = (v: unknown): v is BoardSymbol => {
  const s = v as Partial<BoardSymbol> | null;
  return !!s && typeof s === 'object' && typeof s.id === 'string' && typeof s.name === 'string' && typeof s.file === 'string'
    && (s.start === undefined || Number.isSafeInteger(s.start)) && (s.end === undefined || Number.isSafeInteger(s.end))
    && (s.hash === undefined || typeof s.hash === 'string') && (s.head === undefined || typeof s.head === 'string');
};
const isEntry = (v: unknown): v is BoardEntry => {
  const e = v as Partial<BoardEntry> | null;
  return !!e && e.version === 1 && typeof e.actorId === 'string' && /^[\w.@:/+-]{1,128}$/.test(e.actorId) && typeof e.worktree === 'string' && typeof e.branch === 'string'
    && Array.isArray(e.writes) && e.writes.every(isSymbol) && Array.isArray(e.reads) && e.reads.every(isSymbol) && Array.isArray(e.creates) && typeof e.lastSeenAt === 'string'
    // Peer-written and later passed to git: a commit id only, never an option or a revision expression.
    && (e.baseAtDeclare === undefined || (typeof e.baseAtDeclare === 'string' && /^[0-9a-f]{40,64}$/.test(e.baseAtDeclare)));
};

/** The default branch (`main`, else `master`), or null. */
async function defaultBranch(root: string): Promise<string | null> {
  for (const b of ['main', 'master']) {
    try { await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${b}^{commit}`]); return b; } catch { /* next */ }
  }
  return null;
}

/**
 * Why a subject is no longer live, or null when it is — the clone's single lifecycle decider.
 * Predicates in order: idle expiry, worktree removed, branch deleted, branch merged. A predicate
 * whose evidence the subject does not carry is reported in `unknown` and skipped.
 */
async function endReason(root: string, s: LifecycleSubject, now: number, ctx: GitContext): Promise<LifecycleVerdict> {
  const unknown: LifecycleUnknown[] = [];
  const ended = (reason: EndReason): LifecycleVerdict => ({ reason, unknown });

  // Idle expiry. A recorded-but-unparseable timestamp is expired (it cannot be shown to be
  // recent); NO timestamp at all is unknown, so a subject that never carried one survives.
  if (s.lastSeenAt === undefined) unknown.push('expiry-unknown-no-timestamp');
  else {
    const seen = Date.parse(s.lastSeenAt);
    if (!Number.isFinite(seen) || now - seen > PANIC_SESSION_EXPIRY_MS) return ended('expired');
  }

  // The directory the subject lives in must still exist. `existsSync(undefined)` is false, so an
  // unrecorded directory is reported unknown rather than read as a removed worktree.
  const dir = s.worktree ?? s.root;
  if (dir === undefined) unknown.push('worktree-unknown-not-recorded');
  else if (!existsSync(dir)) return ended('worktree-removed');
  if (s.worktree !== undefined) {
    // Only a worktree of this clone counts (a crafted path elsewhere is not one).
    const wt = await realpath(s.worktree).catch(() => s.worktree!);
    if (ctx.worktrees && !ctx.worktrees.has(s.worktree) && !ctx.worktrees.has(wt)) return ended('worktree-removed');
    if (s.root) {
      const rel = relative(wt, await realpath(s.root).catch(() => s.root!));
      if (rel.startsWith('..') || isAbsolute(rel)) return ended('worktree-removed');
    }
  }

  // A detached HEAD, or a name git cannot be asked about: only expiry and release end it.
  if (!s.branch) { unknown.push('branch-unknown-detached-or-unrecorded'); return { reason: null, unknown }; }
  if (!usableBranch(s.branch)) { unknown.push('branch-unknown-unusable-name'); return { reason: null, unknown }; }
  // Git could not list the clone's branches at all (not a work tree, no git binary, a dubious
  // ownership refusal): that is no evidence a branch is gone. Unknown, never 'branch-deleted'.
  if (!ctx.branchTips) { unknown.push('branch-unknown-git-could-not-be-asked'); return { reason: null, unknown }; }
  const tip = ctx.branchTips.get(s.branch);
  if (tip === undefined) {
    // Absent now. Only positive evidence that it WAS a branch makes that a deletion; a name that
    // was never one (a task id) proves nothing.
    if (!s.branchKnownRef) { unknown.push('branch-unknown-never-a-known-branch'); return { reason: null, unknown }; }
    return ended('branch-deleted');
  }
  // Merged: the branch has commits of its own, and they are now in the default branch.
  // A fast-forward or pull onto main moves the tip along main's own history: that is not a merge.
  if (!ctx.main) unknown.push('branch-merged-unknown-no-default-branch');
  else if (s.branch !== ctx.main) {
    // Peer-written: hex-validated before it can stand in for a revision git is asked about.
    if (!s.baseAtDeclare || !COMMIT_ID_RE.test(s.baseAtDeclare)) unknown.push('branch-merged-unknown-no-base-commit');
    else if (tip !== s.baseAtDeclare && await mergedIntoMain(root, ctx, tip)) return ended('branch-merged');
  }
  return { reason: null, unknown };
}

/** What the predicates resolve once per batch, so a big batch is not a git-spawn storm. */
interface GitContext {
  main: string | null;
  worktrees: Set<string> | null;
  /** The clone's local branches and their tips, or null when git could not be asked. */
  branchTips: Map<string, string> | null;
  /** main's first-parent history, read at most once. */
  mainFirstParent?: Set<string>;
  /** Memo per tip: is it merged into main (ancestor, but not on main's own first-parent line)? */
  merged: Map<string, boolean>;
}

/** Is `tip` merged into main? Memoized per tip; main's first-parent list is read at most once. */
async function mergedIntoMain(root: string, ctx: GitContext, tip: string): Promise<boolean> {
  const memo = ctx.merged.get(tip);
  if (memo !== undefined) return memo;
  let verdict = false;
  try {
    await git(root, ['merge-base', '--is-ancestor', tip, `refs/heads/${ctx.main}`]);
    ctx.mainFirstParent ??= new Set((await git(root, ['rev-list', '--first-parent', '--max-count=5000', `refs/heads/${ctx.main}`])).split('\n'));
    verdict = !ctx.mainFirstParent.has(tip);
  } catch { /* not an ancestor */ }
  ctx.merged.set(tip, verdict);
  return verdict;
}

/** The clone's local branches and their tips in ONE call, or null when git could not be asked. */
async function localBranchTips(root: string): Promise<Map<string, string> | null> {
  try {
    // lstrip=2, not `:short`: git's short form DISAMBIGUATES, so a branch sharing its name with a
    // tag comes back as `heads/feat-x`. Keyed by the canonical name, then by the `heads/` form as
    // an alias — `symbolic-ref --short` disambiguates too, so that IS the name a subject recorded.
    const { stdout } = await execFileGit('git', ['for-each-ref', '--format=%(objectname) %(refname:lstrip=2)', 'refs/heads/'], { cwd: root });
    const tips = new Map<string, string>();
    const canonical: Array<[string, string]> = [];
    for (const line of String(stdout).split('\n')) {
      const sp = line.indexOf(' ');
      if (sp > 0) canonical.push([line.slice(sp + 1), line.slice(0, sp)]);
    }
    for (const [name, tip] of canonical) tips.set(name, tip);
    // Aliases never shadow a branch actually named `heads/…`.
    for (const [name, tip] of canonical) if (!tips.has(`heads/${name}`)) tips.set(`heads/${name}`, tip);
    return tips;
  } catch {
    return null;
  }
}

/** Whether `name` is a local branch of this clone right now; null when git could not be asked. */
export async function isLocalBranch(root: string, name: string): Promise<boolean | null> {
  if (!usableBranch(name)) return false;
  const tips = await localBranchTips(root);
  return tips ? tips.has(name) : null;
}

/**
 * Judge many lifecycle subjects at once, resolving the default branch, the clone's worktree set and
 * its branch tips ONCE for the batch. The batched wrapper every other record store reaches the
 * board's end predicates through — there is no second copy of the rules. Git work per batch is
 * bounded by the number of distinct branches, not by the number of subjects.
 */
export async function judgeLifecycle<T>(
  root: string,
  items: readonly T[],
  subjectOf: (item: T) => LifecycleSubject,
  opts: { now?: number } = {},
): Promise<Array<{ item: T } & LifecycleVerdict>> {
  if (!items.length) return []; // no subjects: no git calls (the hooks reach this on every tool call)
  const now = opts.now ?? Date.now();
  const branchTips = await localBranchTips(root);
  const ctx: GitContext = {
    branchTips,
    main: branchTips ? (['main', 'master'].find(b => branchTips.has(b)) ?? null) : await defaultBranch(root),
    worktrees: await worktreePaths(root),
    merged: new Map(),
  };
  const out: Array<{ item: T } & LifecycleVerdict> = [];
  for (const item of items) out.push({ item, ...(await endReason(root, subjectOf(item), now, ctx)) });
  return out;
}

/** The worktrees of this clone (absolute, real paths), or null when git cannot list them. */
async function worktreePaths(root: string): Promise<Set<string> | null> {
  try {
    // -z: a path may hold a newline.
    const { stdout } = await execFileGit('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: root });
    const paths = String(stdout).split('\0').filter(l => l.startsWith('worktree ')).map(l => l.slice('worktree '.length));
    const real = await Promise.all(paths.map(p => realpath(p).catch(() => p)));
    return new Set([...paths, ...real]);
  } catch {
    return null;
  }
}

/**
 * Declared symbols whose text changed: the hash at the declared span, else at each place the
 * symbol's first characters now appear (an edit above a symbol moves it without changing it).
 */
async function movedSymbols(e: BoardEntry): Promise<string[]> {
  const moved = new Set<string>();
  const byFile = new Map<string, BoardSymbol[]>();
  for (const s of [...e.writes, ...e.reads]) if (s.hash && s.start !== undefined && s.end !== undefined) (byFile.get(s.file) ?? byFile.set(s.file, []).get(s.file)!).push(s);
  for (const [file, syms] of byFile) {
    let text: string | null;
    try { text = await readFileConfined(e.root ?? e.worktree, file, 4 * 1024 * 1024); } catch { text = null; }
    for (const s of syms) {
      if (text !== null && symbolHash(text.slice(s.start, s.end)) === s.hash) continue;
      const len = s.end! - s.start!;
      let found = false;
      if (text !== null && s.head) {
        for (let at = text.indexOf(s.head), tries = 0; at !== -1 && tries < 64 && !found; at = text.indexOf(s.head, at + 1), tries++) {
          found = symbolHash(text.slice(at, at + len)) === s.hash;
        }
      }
      if (!found) moved.add(s.name);
    }
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
  try { names = (await readdir(dir)).filter(n => n.endsWith('.json')).sort(); } catch { names = []; }
  if (names.length > MAX_FILES_READ) {
    out.boundaries.push(`The board directory holds ${names.length} files; the first ${MAX_FILES_READ} were read.`);
    names = names.slice(0, MAX_FILES_READ);
  }
  if (!names.length) return out; // an unused board: no git calls (the hooks read it on every tool call)
  const read: Array<{ entry: BoardEntry; file: string }> = [];
  for (const n of names) {
    let entry: unknown;
    try {
      // Confined, size-checked before reading, regular files only (a FIFO or device never blocks).
      entry = JSON.parse(await readFileConfined(dir, n, MAX_ENTRY_BYTES, true));
    } catch { out.unreadable++; continue; }
    if (!isEntry(entry)) { out.unreadable++; continue; }
    read.push({ entry, file: join(dir, n) });
  }
  // One batch through the shared decider: an entry's branch came from `symbolic-ref`, so it is
  // known to have been a real branch and an absent one is a deletion.
  const judged = await judgeLifecycle(root, read, r => ({ ...r.entry, branchKnownRef: true }), opts);
  const unknown = new Set<LifecycleUnknown>();
  for (const { item: { entry, file }, reason, unknown: u } of judged) {
    for (const code of u) unknown.add(code);
    if (reason) { out.ended.push({ actorId: entry.actorId, reason, file, lastSeenAt: entry.lastSeenAt }); continue; }
    out.live.push({ entry, moved: await movedSymbols(entry) });
  }
  if (out.unreadable) out.boundaries.push(`${out.unreadable} board entr${out.unreadable === 1 ? 'y' : 'ies'} could not be read and ${out.unreadable === 1 ? 'was' : 'were'} skipped.`);
  // Which end rules actually ran. A rule git could not answer is NOT reported as a deletion, so say
  // plainly that it was skipped rather than leaving "no main or master branch" to stand in for it.
  if (unknown.has('branch-unknown-git-could-not-be-asked')) out.boundaries.push('Git could not list this clone\'s branches: neither a deleted nor a merged branch was detected, and nothing was read as deleted; an entry then ends on release or after 30 minutes without a refresh.');
  else if (unknown.has('branch-merged-unknown-no-default-branch')) out.boundaries.push('No main or master branch: a merged branch is not detected; its entry ends when released, deleted, or expired.');
  else out.boundaries.push('A squash-merged or fast-forwarded branch is not detected as merged; its entry ends when released, when the branch is deleted, or after 30 minutes without a refresh.');
  if (unknown.has('branch-unknown-unusable-name')) out.boundaries.push('An entry recorded a branch name git cannot be asked about: its branch rules were skipped, and it ends on release or after 30 minutes without a refresh.');
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
  // No default branch: the commit checked out at declaration is the base peer notices compare with.
  else { try { baseAtDeclare = await git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']); } catch { /* unborn */ } }
  return { worktree, branch, ...(baseAtDeclare ? { baseAtDeclare } : {}) };
}

/** Live board entries as task descriptors for the coordination tools (write seeds only). */
export async function liveTaskDescriptors(root: string): Promise<Array<{ id: string; branch: string; seedSymbols: string[]; writeMode?: 'append' | 'modify'; worktree: string; root?: string }>> {
  const board = await readBoard(root);
  // Seeds are the symbols resolved at declaration (ids), never raw peer text: an entry with no
  // resolved write (only intended creations) is not a task here.
  return board.live
    .filter(l => l.entry.writes.length > 0)
    .map(l => ({ id: l.entry.actorId, branch: l.entry.branch, seedSymbols: l.entry.writes.map(w => w.id), ...(l.entry.writeMode ? { writeMode: l.entry.writeMode } : {}), worktree: l.entry.worktree, ...(l.entry.root ? { root: l.entry.root } : {}) }));
}

/**
 * Remove the entry files of ended entries (best effort). An entry refreshed since it was judged
 * ended (its `lastSeenAt` changed) is kept.
 */
export async function pruneEnded(ended: BoardRead['ended']): Promise<void> {
  for (const e of ended) {
    try {
      const now = JSON.parse(await readFileConfined(dirname(e.file), basename(e.file), MAX_ENTRY_BYTES, true)) as { lastSeenAt?: string };
      if (now.lastSeenAt !== e.lastSeenAt) continue;
    } catch { /* unreadable: nothing to keep */ }
    await rm(e.file, { force: true }).catch(() => undefined);
  }
}
