/**
 * Session structural ledger (change: add-session-structural-ledger).
 *
 * One small record per MCP server process — the session, as for the epistemic lease — of the
 * symbols the agent was SERVED and the symbols that were EDITED, each with its normalized content
 * hash (`symbol-content-hash.ts`: whitespace and comments do not change it, a real edit does). It
 * stores addresses and hashes only, never file contents.
 *
 * Two facts come from it, both stated neutrally and never blocking:
 *
 * - **Background change.** A served symbol whose body changed since it was served, where the change
 *   is not the agent's own. "Own" is decided by the harness's after-edit hook (`openlore check-edit
 *   --hook`, or the agent-loop hooks), which appends each file the agent edits to the worktree's
 *   agent-edit log. Without any such report in this session the note is withheld, with the reason in
 *   `openlore status`, because an edit cannot otherwise be told apart from another process's.
 * - **Edit oscillation.** A symbol that returns, for the second time, to a version it already had
 *   this session (A → B → A → B). The versions come from the MCP watcher's re-index batches when the
 *   watcher runs in this process, and are otherwise sampled at each tool call (disclosed).
 *
 * Other processes (status, the panic-check hook) read the persisted ledger of the single live
 * server for the worktree, and withhold the facts when there is none or more than one.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, unlinkSync, appendFileSync, mkdirSync, openSync, fstatSync, closeSync, realpathSync, writeFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { safeJoin } from '../../utils/path-confinement.js';
import { detectLanguage } from '../analyzer/language-detection.js';
import { OPENLORE_DIR } from '../../constants.js';
import { emittedText } from './generated-file-guard.js';

/** Where ledgers live, under `.openlore/`. */
export const SESSION_LEDGER_DIR = 'session-ledger';
/** The worktree's agent-edit log, appended by the after-edit hook. */
export const AGENT_EDITS_FILE = 'agent-edits.jsonl';
/** A ledger not written for this long belongs to no live session (the panic-state session rule). */
export const LEDGER_EXPIRY_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 2000;
const MAX_EDITED_LISTED = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES_PER_RESPONSE = 10;
/** Served files are hashed in the background; larger ones would stall the event loop. */
const MAX_SERVED_FILE_BYTES = 256 * 1024;
/** Served text kept in memory until the file changes; the oldest is dropped past this. */
const MAX_PENDING_BYTES = 16 * 1024 * 1024;
/** Files hashed per watcher batch; a larger batch (a branch switch, a formatter) is bulk, not an edit loop. */
const MAX_FILES_PER_BATCH = 20;
/** How long a tool call waits for the ledger before it answers with what is known. */
const REFRESH_BUDGET_MS = 300;
/** An agent edit and the watcher's record of it land within this much of each other. */
const OWN_EDIT_WINDOW_MS = 5000;
/** How far before the watcher's record an agent edit may lie (debounce plus a slow re-index). */
const OWN_EDIT_LAG_MS = 30_000;
const MAX_NAMED = 3;
const NO_AGENT_EDITS = 'No after-edit hook has reported an edit this session, so the agent\'s own edits cannot be told apart from other processes\' edits; background-change notes are withheld. `openlore install` in the repository wires one for Claude Code.';
/** Returns to an earlier version before a loop is reported (A → B → A → B: two). */
export const OSCILLATION_RETURNS = 2;
/** The agent-edit log is cut back to its newest entries past this size. */
const AGENT_EDITS_MAX_BYTES = 256 * 1024;
const AGENT_EDITS_KEEP = 1000;

export interface ServedEntry { id: string; name: string; file: string; hash: string; servedAt: number }
/** One version of a symbol: its hash, when it was observed, and whether by sampling at a tool call. */
/** A symbol's version: its body hash, and its declaration-line hash when the parser gave one. */
interface Version { hash: string; at: number; sampled: boolean; sig?: string }
export interface EditedEntry { id: string; name: string; file: string; versions: Version[]; returns: number; exported?: boolean }

/**
 * How the agent's edits changed the session's symbols (change: add-ledger-contract-hashes-and-counts):
 * counts only, never a percentage or threshold. A code symbol is counted when the agent's after-edit
 * hook attributes one of its versions to the agent and its latest version differs from its first:
 * in exactly one of `bodyOnly`, `signatureChanged`, `unclassified` (a declaration line missing or one
 * the parser may have cut), or `firstSeenAfterEdit` (its first observed version was already the
 * agent's edit, so its baseline is unknown). `exportsChanged` counts the changed ones a module exports.
 */
export interface ChangeKinds { bodyOnly: number; signatureChanged: number; unclassified: number; firstSeenAfterEdit: number; exportsChanged: number }

/**
 * A declaration line the parser may have cut or overrun: it stops at the first `{` (an object type,
 * a destructured parameter, a Go `interface{}`) and keeps an arrow function's expression body.
 * Such a line is not compared.
 */
function reliableSignature(sig: string): boolean {
  if (sig.includes('=>')) return false;
  const t = sig.replace(/->/g, ''); // a Python return arrow
  const count = (c: string) => t.split(c).length - 1;
  if (count('(') !== count(')') || count('[') !== count(']') || count('<') !== count('>')) return false;
  return !/\b(?:interface|struct|func)\s*$/.test(t.trim()) && !/[:,(<|&]\s*$/.test(t.trim());
}

export interface BackgroundChange { id: string; name: string; file: string; servedAt: string; changedAt: string }
export interface EditOscillation { id: string; name: string; file: string; returns: number; cycle: string[] }

/** The persisted ledger, as other processes read it. */
export interface LedgerSnapshot {
  schemaVersion: 1;
  pid: number;
  root: string;
  startedAt: string;
  updatedAt: string;
  /** How edit versions are observed: the in-process watcher, or sampling at tool calls. */
  editSource: 'watcher' | 'sampled';
  /** True once an after-edit hook reported an agent edit this session. */
  agentEditsReported: boolean;
  counts: { served: number; edited: number; untracked: number; dropped: number };
  changeKinds?: ChangeKinds;
  /** Watcher batches of more than 20 files (a branch switch, a stash), which record no versions. */
  bulkBatches?: number;
  /**
   * Symbols this session saw change (more than one version), first {@link MAX_EDITED_LISTED}: the
   * work in flight, even once committed (the handoff briefing's touched set).
   */
  edited?: Array<{ id: string; name: string; file: string }>;
  backgroundChanges: BackgroundChange[];
  editOscillation: EditOscillation[];
  /** Why background-change notes are withheld, when they are. */
  withheld?: string;
}

/** Normalized per-symbol hashes for one file's text; `undefined` when the file cannot be hashed. */
export type FileHasher = (file: string, content: string) => Promise<Map<string, { name: string; hash: string; sig?: string; exported?: boolean }> | undefined>;

/** The default hasher: the same extraction and hash the index and changed-set use. */
export const hashFileSymbols: FileHasher = async (file, content) => {
  const language = detectLanguage(file);
  if (language === 'unknown') return undefined;
  try {
    const { extractFileWithContentHashes } = await import('../analyzer/call-graph.js');
    const result = await extractFileWithContentHashes({ path: file, content, language });
    if (!result?.contentHashes) return undefined;
    const names = new Map(result.nodes.map(n => [n.id, n.name]));
    // Every node's declaration line per id, in order (overloads and twins share an id); one the
    // parser may have cut makes the id's signature unknown.
    const sigLists = new Map<string, string[] | null>();
    for (const n of result.nodes) {
      const list = sigLists.get(n.id);
      if (list === null) continue;
      if (!n.signature || !reliableSignature(n.signature)) { sigLists.set(n.id, null); continue; }
      sigLists.set(n.id, [...(list ?? []), n.signature]);
    }
    const sigs = new Map([...sigLists].flatMap(([id, l]) => (l ? [[id, createHash('sha256').update(l.join('\n')).digest('hex').slice(0, 16)] as const] : [])));
    const exported = await exportedSet(content, language);
    const out = new Map<string, { name: string; hash: string; sig?: string; exported?: boolean }>();
    // A twin id (an overload, a re-declared name) joins its hashes, as the changed-set does.
    for (const s of result.contentHashes.symbols) {
      const prev = out.get(s.id);
      const name = names.get(s.id) ?? s.id;
      const sig = sigs.get(s.id);
      // A top-level symbol only: a method shares its name with no export (`Class.method` ids).
      const topLevel = !(s.id.split('::').pop() ?? '').includes('.');
      out.set(s.id, {
        name, hash: prev ? `${prev.hash}+${s.hash}` : s.hash,
        ...(sig !== undefined ? { sig } : {}),
        ...(exported && topLevel ? { exported: exported.has(name) } : {}),
      });
    }
    return out;
  } catch {
    return undefined;
  }
};

/** The names a module exports, or undefined for a language the export reader does not know. */
async function exportedSet(content: string, language: string): Promise<Set<string> | undefined> {
  if (language === 'Go') {
    // Go exports by capitalization.
    return new Set([...content.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)/gm)].map(m => m[1]));
  }
  if (language !== 'TypeScript' && language !== 'JavaScript' && language !== 'Python') return undefined;
  try {
    const { exportedNames } = await import('./mcp-handlers/public-surface.js');
    return exportedNames(content, language);
  } catch { return undefined; }
}

/** A whole-file hash for non-code files a briefing names (spec Markdown): whitespace-normalized text. */
export const hashWholeFile: FileHasher = async (file, content) => {
  const hash = createHash('sha256').update(content.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
  return new Map([[`${file}::*`, { name: file, hash }]]);
};

/** Code files get symbol hashes; any other file one whole-file hash. */
/** Non-code files a briefing can name, hashed as a whole. */
const WHOLE_FILE = /\.(?:md|ya?ml|json)$/i;

export const defaultHasher: FileHasher = async (file, content) =>
  (await hashFileSymbols(file, content)) ?? (WHOLE_FILE.test(file) ? hashWholeFile(file, content) : undefined);

/** A persisted `changeKinds` with every count a finite, non-negative integer; anything else is dropped. */
function validChangeKinds(x: unknown): x is ChangeKinds {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const r = x as Record<string, unknown>;
  return ['bodyOnly', 'signatureChanged', 'unclassified', 'firstSeenAfterEdit', 'exportsChanged']
    .every(k => typeof r[k] === 'number' && Number.isSafeInteger(r[k]) && (r[k] as number) >= 0);
}

/** Keep a bookkeeping set bounded on a long session (oldest first out). */
function trimSet(set: Set<string>): void {
  for (const v of set) { if (set.size <= MAX_ENTRIES * 5) break; set.delete(v); }
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function ledgerDir(root: string): string {
  return join(root, OPENLORE_DIR, SESSION_LEDGER_DIR);
}

/** Create the ledger directory with its own `.gitignore`: session files are never committed. */
export function ensureLedgerDir(root: string): string {
  const dir = ledgerDir(root);
  mkdirSync(dir, { recursive: true });
  try { writeFileSync(join(dir, '.gitignore'), '*\n', { flag: 'wx' }); } catch { /* already there */ }
  return dir;
}

/** Append one agent edit to the worktree's log (the after-edit hook's only write). Never throws. */
export function recordAgentEdit(root: string, file: string, at = Date.now()): void {
  try {
    const path = join(ensureLedgerDir(root), AGENT_EDITS_FILE);
    // One descriptor for the append, the size check and the read, so they see the same file.
    const fd = openSync(path, 'a+');
    let keep: string | undefined;
    try {
      appendFileSync(fd, JSON.stringify({ file, at }) + '\n');
      if (fstatSync(fd).size > AGENT_EDITS_MAX_BYTES) {
        keep = readFileSync(fd, 'utf-8').split('\n').filter(Boolean).slice(-AGENT_EDITS_KEEP).join('\n') + '\n';
      }
    } finally {
      closeSync(fd);
    }
    if (keep !== undefined) void atomicWriteFile(path, keep).catch(() => {});
  } catch { /* the ledger is advisory: a failed write only withholds attribution */ }
}

/** Agent edits since `since` (fail-open: an unreadable log is empty). */
function readAgentEdits(root: string, since: number): Array<{ file: string; at: number }> {
  try {
    const text = readFileSync(join(ledgerDir(root), AGENT_EDITS_FILE), 'utf-8');
    const out: Array<{ file: string; at: number }> = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as { file?: unknown; at?: unknown };
        if (typeof e.file === 'string' && typeof e.at === 'number' && e.at >= since) out.push({ file: e.file, at: e.at });
      } catch { /* a torn line is skipped */ }
    }
    return out;
  } catch {
    return [];
  }
}

/** The in-process ledger of one MCP server session. */
export class SessionLedger {
  readonly root: string;
  readonly startedAt: number;
  private served = new Map<string, ServedEntry>();
  /** Each tracked symbol's first observed version, for the session's net change. */
  private firstVersion = new Map<string, Version>();
  private edited = new Map<string, EditedEntry>();
  /** Last seen mtime of each tracked file, so unchanged files are not re-hashed. */
  private seenMtime = new Map<string, number>();
  private untracked = new Set<string>();
  /** Watcher batches too large to be edits, recorded as no versions. */
  private bulkBatches = 0;
  /** Names being hashed by resolveServed, so a serve arriving meanwhile keeps them. */
  private resolving = new Map<string, Set<string> | 'all'>();
  private dropped = 0;
  /** Facts already stated in a note: `id@hash` for background changes, `id#returns` for loops. */
  private delivered = new Set<string>();
  /** Loops already handed to the panic layer. */
  private loopsSeen = new Set<string>();
  private editSource: 'watcher' | 'sampled' = 'sampled';
  private writeTimer: NodeJS.Timeout | undefined;
  /** Serializes the watcher and sampling work so versions land in the order they were observed. */
  private queue: Promise<void> = Promise.resolve();
  /** Reading of served files: its own chain, which a tool call never waits for. */
  private servedQueue: Promise<void> = Promise.resolve();
  /**
   * Served files not hashed yet: the text the agent was shown, held in memory (never persisted) and
   * hashed only once the file changes — so serving costs a read, not a parse.
   */
  private pending = new Map<string, { content: string; servedAt: number; names: Set<string> | 'all' }>();
  private pendingBytes = 0;

  private disposed = false;

  constructor(root: string, private readonly hasher: FileHasher = defaultHasher, private readonly now: () => number = Date.now) {
    this.root = root;
    this.startedAt = now();
  }

  /** The watcher runs in this process: edit versions come from its batches. */
  setWatcherActive(active: boolean): void {
    this.editSource = active ? 'watcher' : 'sampled';
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(work, work).catch(() => {});
    return this.queue;
  }

  /** Wait for all queued hashing (tests). */
  async settle(): Promise<void> {
    await this.servedQueue;
    await this.queue;
  }

  private async readCurrent(file: string, maxBytes = MAX_FILE_BYTES): Promise<string | undefined> {
    try {
      // One handle for the size check and the read, so a file swapped in between is not read.
      const fh = await open(safeJoin(this.root, file), 'r');
      try {
        if ((await fh.stat()).size > maxBytes) return undefined;
        return await fh.readFile('utf-8');
      } finally {
        await fh.close();
      }
    } catch {
      return undefined;
    }
  }

  private cap<T>(map: Map<string, T>): void {
    while (map.size > MAX_ENTRIES) {
      map.delete(map.keys().next().value as string);
      this.dropped++;
    }
  }

  /**
   * Record what a tool response served: symbols by (name, file), or whole files (every symbol in
   * them, for a file-level answer such as a skeleton). The text is kept until the file changes and
   * hashed then; a file too large to keep is counted untracked.
   */
  recordServed(items: ReadonlyArray<{ file: string; name?: string }>): Promise<void> {
    const at = this.now(); // when it was served, before any read: a later hook entry is a later edit
    const byFile = new Map<string, Set<string> | 'all'>();
    for (const it of items) {
      if (!it.file) continue;
      const prev = byFile.get(it.file);
      if (it.name === undefined) byFile.set(it.file, 'all');
      else if (prev !== 'all') byFile.set(it.file, (prev ?? new Set()).add(it.name));
    }
    const files = [...byFile].slice(0, MAX_FILES_PER_RESPONSE);
    const work = async () => {
      for (const [file, names] of files) {
        // A file no hasher handles is untracked from the start, not merely "not changed yet".
        if (detectLanguage(file) === 'unknown' && !WHOLE_FILE.test(file)) { this.untracked.add(file); continue; }
        const content = await this.readCurrent(file, MAX_SERVED_FILE_BYTES);
        if (content === undefined) { this.untracked.add(file); continue; }
        // Re-serving shows the agent the current text: it becomes the version the agent read, for
        // the names served now and before.
        const before = this.pending.get(file);
        const inFlight = this.resolving.get(file);
        const earlier = [...this.served.values()].filter(e => e.file === file).map(e => e.name);
        const merged: Set<string> | 'all' = names === 'all' || before?.names === 'all' || inFlight === 'all'
          ? 'all' : new Set([...names, ...(before?.names ?? []), ...(inFlight ?? []), ...earlier]);
        this.untracked.delete(file); // tracked again
        if (before) this.pendingBytes -= before.content.length;
        this.pending.delete(file);
        this.pending.set(file, { content, servedAt: at, names: merged });
        this.pendingBytes += content.length;
        this.seenMtime.set(file, await this.mtime(file));
      }
      // Bounded memory: the oldest unhashed served files are dropped and counted.
      for (const [file, p] of this.pending) {
        if (this.pendingBytes <= MAX_PENDING_BYTES) break;
        this.pending.delete(file);
        this.pendingBytes -= p.content.length;
        this.untracked.add(file);
        this.dropped++;
      }
      this.scheduleWrite();
    };
    this.servedQueue = this.servedQueue.then(work, work).catch(() => {});
    return this.servedQueue;
  }

  /** Hash a served file's kept text: the versions the agent read. Names the hasher lacks are untracked. */
  private async resolveServed(file: string): Promise<void> {
    const p = this.pending.get(file);
    if (!p) return;
    this.pending.delete(file);
    this.pendingBytes -= p.content.length;
    this.resolving.set(file, p.names);
    const hashes = await this.hasher(file, p.content).finally(() => this.resolving.delete(file));
    if (!hashes) { this.untracked.add(file); return; }
    const found = new Set<string>();
    for (const [id, h] of hashes) {
      if (p.names !== 'all' && !p.names.has(h.name)) continue;
      found.add(h.name);
      this.served.delete(id); // the latest serve is the one that counts
      this.served.set(id, { id, name: h.name, file, hash: h.hash, servedAt: p.servedAt });
      this.noteVersion(id, h.name, file, { hash: h.hash, at: p.servedAt, sampled: true, ...(h.sig ? { sig: h.sig } : {}) }, h.exported);
    }
    if (p.names !== 'all') for (const n of p.names) if (!found.has(n)) this.untracked.add(`${file}::${n}`);
    this.cap(this.served);
  }

  /**
   * Re-indexed files from the in-process watcher: each symbol's new version, observed `at` the
   * batch. A bulk batch hashes the files this session tracks first and counts the rest untracked.
   */
  recordReindexed(files: ReadonlyArray<{ rel: string; content: string }>, at = this.now()): Promise<void> {
    // A bulk batch (a branch switch, a stash, a formatter run) is not an edit: switching back and
    // forth would read as a loop. Its files record no version; they are counted untracked.
    if (files.length > MAX_FILES_PER_BATCH) {
      for (const f of files) this.untracked.add(f.rel);
      this.bulkBatches++;
      return this.queue;
    }
    const kept = files;
    return this.enqueue(async () => {
      for (const f of kept) {
        await this.observe(f.rel, f.content, at, false);
        await new Promise(r => setImmediate(r)); // let a tool call in between files
      }
      this.scheduleWrite();
    });
  }

  private async mtime(file: string): Promise<number> {
    try { return (await stat(safeJoin(this.root, file))).mtimeMs; } catch { return -1; }
  }

  private async observe(file: string, content: string, at: number, sampled: boolean): Promise<void> {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) { this.untracked.add(file); return; }
    const kept = this.pending.get(file);
    if (kept && kept.content === content) { this.seenMtime.set(file, await this.mtime(file)); return; } // unchanged since served
    await this.servedQueue; // a serve still being read lands first
    await this.resolveServed(file);
    const hashes = await this.hasher(file, content);
    if (!hashes) { this.untracked.add(file); return; }
    for (const [id, h] of hashes) this.noteVersion(id, h.name, file, { hash: h.hash, at, sampled, ...(h.sig ? { sig: h.sig } : {}) }, h.exported);
    this.seenMtime.set(file, await this.mtime(file));
  }

  /** Append a symbol's version; consecutive equal versions are one version. */
  private noteVersion(id: string, name: string, file: string, v: Version, exported?: boolean): void {
    let e = this.edited.get(id);
    if (!e) {
      e = { id, name, file, versions: [], returns: 0 };
      this.edited.set(id, e);
      this.cap(this.edited);
    }
    if (exported !== undefined) e.exported = exported || e.exported === true;
    // The first version is kept apart: the version list is trimmed on a long session.
    if (!this.firstVersion.has(id)) this.firstVersion.set(id, v);
    // Evicted from `edited`: its baseline goes too, so a returning id starts over (consistently).
    if (this.firstVersion.size > this.edited.size) for (const k of this.firstVersion.keys()) if (!this.edited.has(k)) this.firstVersion.delete(k);
    if (e.versions.at(-1)?.hash === v.hash) return;
    if (e.versions.some(x => x.hash === v.hash)) e.returns++;
    e.versions.push(v);
    if (e.versions.length > 64) e.versions.splice(0, e.versions.length - 64);
  }

  /**
   * At a tool call: sample the tracked files that changed on disk (the served ones always; all of
   * them when no watcher feeds versions). Bounded: a tool call waits at most {@link REFRESH_BUDGET_MS}
   * for queued work, then answers with what is known.
   */
  async refresh(budgetMs = REFRESH_BUDGET_MS): Promise<void> {
    const work = this.enqueue(async () => {
      const files = new Set<string>([...this.served.values()].map(s => s.file));
      for (const file of this.pending.keys()) files.add(file);
      if (this.editSource === 'sampled') for (const e of this.edited.values()) files.add(e.file);
      for (const file of files) {
        const m = await this.mtime(file);
        if (m === this.seenMtime.get(file)) continue;
        const at = this.now(); // when this file was read: an edit after it is a later version
        const content = await this.readCurrent(file, MAX_SERVED_FILE_BYTES);
        if (content === undefined) { this.untracked.add(file); this.seenMtime.set(file, m); continue; }
        await this.observe(file, content, at, true);
      }
      // Each tool call keeps the persisted ledger current, so other processes see a live session.
      if (this.served.size || this.edited.size) this.scheduleWrite();
    });
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([work, new Promise<void>(r => { timer = setTimeout(r, budgetMs); timer.unref?.(); })]);
    if (timer) clearTimeout(timer);
  }

  /**
   * Whether a version is the agent's own edit: the after-edit hook reported its file around when the
   * watcher observed it, or, for a version sampled at a tool call, at any time since the version
   * before it was observed (sampling cannot separate edits that landed between two calls).
   */
  private ownVersion(file: string, prev: Version | undefined, v: Version, agentEdits: ReadonlyArray<{ file: string; at: number }>): boolean {
    return agentEdits.some(a => a.file === file && (v.sampled
      ? a.at > (prev?.at ?? -Infinity) && a.at <= v.at
      // The watcher records a version after its debounce and re-index, which can lag the edit.
      : a.at > (prev?.at ?? -Infinity) && a.at >= v.at - OWN_EDIT_LAG_MS && a.at <= v.at + OWN_EDIT_WINDOW_MS));
  }

  /** The current facts. `agentEdits` defaults to the worktree's agent-edit log since the session began. */
  facts(agentEdits = readAgentEdits(this.root, this.startedAt)): {
    backgroundChanges: BackgroundChange[];
    editOscillation: EditOscillation[];
    agentEditsReported: boolean;
    withheld?: string;
  } {
    const agentEditsReported = agentEdits.length > 0;
    const backgroundChanges: BackgroundChange[] = [];
    for (const s of this.served.values()) {
      const e = this.edited.get(s.id);
      const k = e ? e.versions.length - 1 : -1;
      if (!e || k < 0 || e.versions[k].hash === s.hash) continue;
      // Read again since: the agent holds the current text, so nothing changed under it.
      const again = this.pending.get(s.file);
      if (again && again.servedAt >= e.versions[k].at && (again.names === 'all' || again.names.has(s.name))) continue;
      if (this.ownVersion(s.file, e.versions[k - 1], e.versions[k], agentEdits)) continue;
      backgroundChanges.push({
        id: emittedText(s.id), name: emittedText(s.name), file: emittedText(s.file),
        servedAt: new Date(s.servedAt).toISOString(), changedAt: new Date(e.versions[k].at).toISOString(),
      });
    }
    const editOscillation: EditOscillation[] = [];
    for (const e of this.edited.values()) {
      if (e.returns < OSCILLATION_RETURNS) continue;
      editOscillation.push({ id: emittedText(e.id), name: emittedText(e.name), file: emittedText(e.file), returns: e.returns, cycle: e.versions.slice(-6).map(v => v.hash) });
    }
    return {
      backgroundChanges: agentEditsReported ? backgroundChanges : [],
      editOscillation,
      agentEditsReported,
      ...(agentEditsReported ? {} : { withheld: NO_AGENT_EDITS }),
    };
  }

  /**
   * The neutral note for the next tool response: new background changes (at most three named, the
   * rest counted) and new edit loops. Each fact is stated once. `null` when there is nothing new.
   * Names and paths are screened repository text.
   */
  takeNote(agentEdits?: Array<{ file: string; at: number }>): string | null {
    const f = this.facts(agentEdits);
    const lines: string[] = [];
    const key = (c: BackgroundChange) => `${c.id}@${c.changedAt}`;
    const fresh = f.backgroundChanges.filter(c => !this.delivered.has(key(c)));
    if (fresh.length) {
      const named = fresh.slice(0, MAX_NAMED).map(c => `${c.name} (${c.file}) — its body changed since you read it at ${hhmm(Date.parse(c.servedAt))}`);
      lines.push(`Served earlier: ${named.join('; ')}${fresh.length > MAX_NAMED ? `; and ${fresh.length - MAX_NAMED} more` : ''}.`);
      for (const c of fresh) this.delivered.add(key(c));
    }
    const loops = f.editOscillation.filter(o => !this.delivered.has(`${o.id}#${o.returns}`));
    for (const o of loops.slice(0, MAX_NAMED)) {
      lines.push(`${o.name} (${o.file}) returned to an earlier version ${o.returns === 2 ? 'twice' : `${o.returns} times`} this session.`);
    }
    if (loops.length > MAX_NAMED) lines.push(`${loops.length - MAX_NAMED} more symbol(s) returned to an earlier version again.`);
    for (const o of loops) this.delivered.add(`${o.id}#${o.returns}`);
    trimSet(this.delivered);
    trimSet(this.untracked);
    if (!lines.length) return null;
    return `[openlore freshness] ${lines.join(' ')} Informational signal.`;
  }

  /**
   * Symbols that reached an edit loop since the last call (the panic layer's input): each symbol
   * once, when it first returns to an earlier version for the second time. Further returns are in
   * the note and the status, but add no more to the panic score.
   */
  takeNewOscillations(): EditOscillation[] {
    const out = this.facts([]).editOscillation.filter(o => !this.loopsSeen.has(o.id));
    for (const o of out) this.loopsSeen.add(o.id);
    return out;
  }

  /**
   * How the agent's edits changed the session's code symbols, net of first and latest versions.
   * Undefined without an after-edit report: the agent's edits cannot be told from others'.
   */
  changeKinds(agentEdits = readAgentEdits(this.root, this.startedAt)): ChangeKinds | undefined {
    if (!agentEdits.length) return undefined;
    const k: ChangeKinds = { bodyOnly: 0, signatureChanged: 0, unclassified: 0, firstSeenAfterEdit: 0, exportsChanged: 0 };
    for (const e of this.edited.values()) {
      if (e.id.endsWith('::*')) continue; // a whole file (Markdown, YAML), not a symbol
      const first = this.firstVersion.get(e.id);
      const last = e.versions.at(-1);
      if (!first || !last) continue;
      const own = e.versions.some((v, i) => i > 0 && this.ownVersion(e.file, e.versions[i - 1], v, agentEdits));
      // Its first observation was already the agent's edit (a file read outside OpenLore, then edited).
      if (this.ownVersion(e.file, undefined, first, agentEdits) && !this.servedBefore(e.id, first)) { k.firstSeenAfterEdit++; continue; }
      if (!own || first.hash === last.hash) continue;
      if (first.sig === undefined || last.sig === undefined) k.unclassified++;
      else if (first.sig === last.sig) k.bodyOnly++;
      else k.signatureChanged++;
      if (e.exported) k.exportsChanged++;
    }
    return k;
  }

  /** Whether the version was the one served (its text was read through OpenLore before any edit). */
  private servedBefore(id: string, v: Version): boolean {
    const s = this.served.get(id);
    return !!s && s.hash === v.hash && s.servedAt <= v.at;
  }

  snapshot(): LedgerSnapshot {
    const f = this.facts();
    return {
      schemaVersion: 1,
      pid: process.pid,
      root: this.root,
      startedAt: new Date(this.startedAt).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
      editSource: this.editSource,
      agentEditsReported: f.agentEditsReported,
      ...(this.bulkBatches ? { bulkBatches: this.bulkBatches } : {}),
      edited: [...this.edited.values()].filter(e => e.versions.length > 1).slice(-MAX_EDITED_LISTED)
        .map(e => ({ id: emittedText(e.id), name: emittedText(e.name), file: emittedText(e.file) })),
      counts: { served: this.served.size + [...this.pending.values()].reduce((n, p) => n + (p.names === 'all' ? 1 : p.names.size), 0), edited: [...this.edited.values()].filter(e => e.versions.length > 1).length, untracked: this.untracked.size, dropped: this.dropped },
      ...(f.agentEditsReported ? { changeKinds: this.changeKinds() } : {}),
      backgroundChanges: f.backgroundChanges,
      editOscillation: f.editOscillation,
      ...(f.withheld ? { withheld: f.withheld } : {}),
    };
  }

  private scheduleWrite(): void {
    if (this.writeTimer || this.disposed) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.persist();
    }, 500);
    this.writeTimer.unref?.();
  }

  /** Write the snapshot for other processes (atomic; failures are ignored). */
  async persist(): Promise<void> {
    if (this.disposed) return;
    try {
      const path = join(ensureLedgerDir(this.root), `${process.pid}.json`);
      await atomicWriteFile(path, JSON.stringify(this.snapshot(), null, 2) + '\n');
      // Disposed while writing: the session is over, so its file must not outlive it.
      if (this.disposed) { try { unlinkSync(path); } catch { /* gone */ } }
    } catch { /* advisory */ }
  }

  /** Remove this session's ledger (process exit). */
  dispose(): void {
    this.disposed = true;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    try { unlinkSync(join(ledgerDir(this.root), `${process.pid}.json`)); } catch { /* already gone */ }
  }
}

/** Collect (file, name) pairs a tool result served. `name` absent means the whole file. */
export function servedItems(tool: string, result: unknown): Array<{ file: string; name?: string }> {
  if (!result || typeof result !== 'object') return [];
  const r = result as Record<string, unknown>;
  const rows = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
  const pick = (row: Record<string, unknown>) => {
    const file = typeof row.filePath === 'string' ? row.filePath : typeof row.file === 'string' ? row.file : undefined;
    const name = typeof row.name === 'string' ? row.name : undefined;
    return file && name ? [{ file, name }] : [];
  };
  switch (tool) {
    case 'orient':
      return [
        ...rows(r.relevantFunctions).flatMap(pick),
        // A spec file a briefing names is tracked as a whole file.
        ...rows(r.specDomains).flatMap(d => (typeof d.specFile === 'string' ? [{ file: d.specFile }] : [])),
      ];
    case 'get_function_skeleton':
      return typeof r.filePath === 'string' ? [{ file: r.filePath }] : [];
    case 'get_subgraph':
      return rows(r.nodes).filter(n => n.isExternal !== true).flatMap(pick);
    case 'search_code':
      return rows(r.results).slice(0, 5).flatMap(pick);
    default:
      return [];
  }
}

/**
 * A ledger file is repository-controlled: accept it only in the shape this module writes, for this
 * root and the pid in its name, updated recently and not in the future; screen its text fields.
 */
function validSnapshot(v: unknown, root: string, filePid: number, now: number): LedgerSnapshot | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const s = v as Record<string, unknown>;
  const updated = typeof s.updatedAt === 'string' ? Date.parse(s.updatedAt) : NaN;
  const counts = s.counts as Record<string, unknown> | undefined;
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0);
  if (s.schemaVersion !== 1 || s.pid !== filePid || !Number.isInteger(filePid) || filePid <= 1) return undefined;
  if (typeof s.root !== 'string' || !samePath(s.root, root)) return undefined;
  if (!Number.isFinite(updated) || updated > now + 60_000 || now - updated > LEDGER_EXPIRY_MS) return undefined;
  const list = <T>(x: unknown, ok: (e: Record<string, unknown>) => T | undefined): T[] =>
    (Array.isArray(x) ? x.slice(0, 100) : []).flatMap(e => (e && typeof e === 'object' ? [ok(e as Record<string, unknown>)] : [])).filter((e): e is T => e !== undefined);
  const str = (x: unknown) => (typeof x === 'string' ? emittedText(x) : undefined);
  return {
    schemaVersion: 1,
    pid: filePid,
    root,
    startedAt: str(s.startedAt) ?? '',
    updatedAt: new Date(updated).toISOString(),
    editSource: s.editSource === 'watcher' ? 'watcher' : 'sampled',
    agentEditsReported: s.agentEditsReported === true,
    counts: { served: num(counts?.served), edited: num(counts?.edited), untracked: num(counts?.untracked), dropped: num(counts?.dropped) },
    ...(validChangeKinds(s.changeKinds) ? { changeKinds: s.changeKinds } : {}),
    ...(num(s.bulkBatches) ? { bulkBatches: num(s.bulkBatches) } : {}),
    edited: list(s.edited, e => {
      const [id, name, file] = [str(e.id), str(e.name), str(e.file)];
      return id && name && file ? { id, name, file } : undefined;
    }).slice(0, MAX_EDITED_LISTED),
    backgroundChanges: list(s.backgroundChanges, e => {
      const [id, name, file, servedAt, changedAt] = [str(e.id), str(e.name), str(e.file), str(e.servedAt), str(e.changedAt)];
      return id && name && file && servedAt && changedAt ? { id, name, file, servedAt, changedAt } : undefined;
    }),
    editOscillation: list(s.editOscillation, e => {
      const [id, name, file] = [str(e.id), str(e.name), str(e.file)];
      const cycle = Array.isArray(e.cycle) ? e.cycle.slice(0, 8).map(str).filter((h): h is string => !!h) : [];
      return id && name && file ? { id, name, file, returns: num(e.returns), cycle } : undefined;
    }),
    ...(str(s.withheld) ? { withheld: str(s.withheld) } : {}),
  };
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
  return a === b || real(a) === real(b);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/**
 * The live session's ledger for a worktree, as a separate process (status, a hook) reads it: exactly
 * one live server's snapshot, or the reason none is used. Never guesses between several.
 */
export function readLiveLedger(root: string, now = Date.now()): { ledger: LedgerSnapshot } | { withheld: string } {
  let names: string[];
  try { names = readdirSync(ledgerDir(root)).filter(n => /^\d+\.json$/.test(n)); } catch { names = []; }
  const live: LedgerSnapshot[] = [];
  for (const n of names) {
    try {
      const path = join(ledgerDir(root), n);
      const snap = validSnapshot(JSON.parse(readFileSync(path, 'utf-8')), root, Number(n.slice(0, -5)), now);
      if (snap && alive(snap.pid)) live.push(snap);
    } catch { /* a torn or foreign file is not a session */ }
  }
  if (live.length === 1) return { ledger: live[0] };
  return { withheld: live.length === 0
    ? 'No live OpenLore MCP server has a session ledger for this worktree.'
    : `${live.length} live OpenLore MCP servers have a session ledger for this worktree; their facts are not merged or chosen between.` };
}
