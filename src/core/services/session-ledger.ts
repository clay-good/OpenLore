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
import { readdirSync, readFileSync, statSync, unlinkSync, appendFileSync, mkdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { safeJoin } from '../../utils/path-confinement.js';
import { detectLanguage } from '../analyzer/language-detection.js';
import { OPENLORE_DIR } from '../../constants.js';

/** Where ledgers live, under `.openlore/`. */
export const SESSION_LEDGER_DIR = 'session-ledger';
/** The worktree's agent-edit log, appended by the after-edit hook. */
export const AGENT_EDITS_FILE = 'agent-edits.jsonl';
/** A ledger not written for this long belongs to no live session (the panic-state session rule). */
export const LEDGER_EXPIRY_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 2000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES_PER_RESPONSE = 10;
const MAX_NAMED = 3;
const NO_AGENT_EDITS = 'No after-edit hook has reported an edit this session, so the agent\'s own edits cannot be told apart from other processes\' edits; background-change notes are withheld. `openlore setup --check-edit-hook claude` installs one for Claude Code.';
/** Returns to an earlier version before a loop is reported (A → B → A → B: two). */
export const OSCILLATION_RETURNS = 2;
/** The agent-edit log is cut back to its newest entries past this size. */
const AGENT_EDITS_MAX_BYTES = 256 * 1024;
const AGENT_EDITS_KEEP = 1000;

export interface ServedEntry { id: string; name: string; file: string; hash: string; servedAt: number }
export interface EditedEntry { id: string; name: string; file: string; hashes: string[]; returns: number; lastAt: number }

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
  backgroundChanges: BackgroundChange[];
  editOscillation: EditOscillation[];
  /** Why background-change notes are withheld, when they are. */
  withheld?: string;
}

/** Normalized per-symbol hashes for one file's text; `undefined` when the file cannot be hashed. */
export type FileHasher = (file: string, content: string) => Promise<Map<string, { name: string; hash: string }> | undefined>;

/** The default hasher: the same extraction and hash the index and changed-set use. */
export const hashFileSymbols: FileHasher = async (file, content) => {
  const language = detectLanguage(file);
  if (language === 'unknown') return undefined;
  try {
    const { extractFileWithContentHashes } = await import('../analyzer/call-graph.js');
    const result = await extractFileWithContentHashes({ path: file, content, language });
    if (!result?.contentHashes) return undefined;
    const names = new Map(result.nodes.map(n => [n.id, n.name]));
    const out = new Map<string, { name: string; hash: string }>();
    // A twin id (an overload, a re-declared name) joins its hashes, as the changed-set does.
    for (const s of result.contentHashes.symbols) {
      const prev = out.get(s.id);
      out.set(s.id, { name: names.get(s.id) ?? s.id, hash: prev ? `${prev.hash}+${s.hash}` : s.hash });
    }
    return out;
  } catch {
    return undefined;
  }
};

/** A whole-file hash for non-code files a briefing names (spec Markdown): whitespace-normalized text. */
export const hashWholeFile: FileHasher = async (file, content) => {
  const hash = createHash('sha256').update(content.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);
  return new Map([[`${file}::*`, { name: file, hash }]]);
};

/** Code files get symbol hashes; any other file one whole-file hash. */
export const defaultHasher: FileHasher = async (file, content) =>
  (await hashFileSymbols(file, content)) ?? (/\.(?:md|ya?ml|json)$/i.test(file) ? hashWholeFile(file, content) : undefined);

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function ledgerDir(root: string): string {
  return join(root, OPENLORE_DIR, SESSION_LEDGER_DIR);
}

/** Append one agent edit to the worktree's log (the after-edit hook's only write). Never throws. */
export function recordAgentEdit(root: string, file: string, at = Date.now()): void {
  try {
    const dir = ledgerDir(root);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, AGENT_EDITS_FILE);
    appendFileSync(path, JSON.stringify({ file, at }) + '\n');
    if (statSync(path).size > AGENT_EDITS_MAX_BYTES) {
      const keep = readFileSync(path, 'utf-8').split('\n').filter(Boolean).slice(-AGENT_EDITS_KEEP).join('\n') + '\n';
      void atomicWriteFile(path, keep).catch(() => {});
    }
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
  private edited = new Map<string, EditedEntry>();
  /** Last seen mtime of each tracked file, so unchanged files are not re-hashed. */
  private seenMtime = new Map<string, number>();
  private untracked = new Set<string>();
  private dropped = 0;
  /** Facts already stated in a note: `id@hash` for background changes, `id#returns` for loops. */
  private delivered = new Set<string>();
  /** Loops already handed to the panic layer. */
  private loopsSeen = new Set<string>();
  private editSource: 'watcher' | 'sampled' = 'sampled';
  private writeTimer: NodeJS.Timeout | undefined;
  /** Serializes the asynchronous hashing so entries land in the order the work arrived. */
  private queue: Promise<void> = Promise.resolve();

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

  /** Wait for queued hashing (tests and the response path). */
  settle(): Promise<void> {
    return this.queue;
  }

  private async readCurrent(file: string): Promise<string | undefined> {
    try {
      const path = safeJoin(this.root, file);
      const st = await stat(path);
      if (st.size > MAX_FILE_BYTES) return undefined;
      return await readFile(path, 'utf-8');
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
   * them, for a file-level answer such as a skeleton). Only the first files are hashed.
   */
  recordServed(items: ReadonlyArray<{ file: string; name?: string }>): Promise<void> {
    const byFile = new Map<string, Set<string> | 'all'>();
    for (const it of items) {
      if (!it.file) continue;
      const prev = byFile.get(it.file);
      if (it.name === undefined) byFile.set(it.file, 'all');
      else if (prev !== 'all') byFile.set(it.file, (prev ?? new Set()).add(it.name));
    }
    const files = [...byFile].slice(0, MAX_FILES_PER_RESPONSE);
    return this.enqueue(async () => {
      for (const [file, names] of files) {
        const content = await this.readCurrent(file);
        const hashes = content === undefined ? undefined : await this.hasher(file, content);
        if (!hashes) { this.untracked.add(file); continue; }
        const at = this.now();
        for (const [id, h] of hashes) {
          if (names !== 'all' && !names.has(h.name)) continue;
          this.served.delete(id); // re-serving refreshes the entry and its position
          this.served.set(id, { id, name: h.name, file, hash: h.hash, servedAt: at });
          this.noteVersion(id, h.name, file, h.hash, at, false);
        }
        this.seenMtime.set(file, await this.mtime(file));
      }
      this.cap(this.served);
      this.scheduleWrite();
    });
  }

  /** Re-indexed files from the in-process watcher: each symbol's new version. */
  recordReindexed(files: ReadonlyArray<{ rel: string; content: string }>): Promise<void> {
    return this.enqueue(async () => {
      for (const f of files) await this.observe(f.rel, f.content);
      this.scheduleWrite();
    });
  }

  private async mtime(file: string): Promise<number> {
    try { return (await stat(safeJoin(this.root, file))).mtimeMs; } catch { return -1; }
  }

  private async observe(file: string, content: string): Promise<void> {
    if (Buffer.byteLength(content) > MAX_FILE_BYTES) { this.untracked.add(file); return; }
    const hashes = await this.hasher(file, content);
    if (!hashes) { this.untracked.add(file); return; }
    const at = this.now();
    for (const [id, h] of hashes) this.noteVersion(id, h.name, file, h.hash, at, true);
    this.seenMtime.set(file, await this.mtime(file));
  }

  /**
   * Append a symbol's version. A served version seeds the sequence (the agent read it); only an
   * observed edit (`edit`) moves it. Consecutive equal versions are one version.
   */
  private noteVersion(id: string, name: string, file: string, hash: string, at: number, edit: boolean): void {
    let e = this.edited.get(id);
    if (!e) {
      if (!edit) {
        // A served symbol starts its sequence at the version the agent read.
        this.edited.set(id, { id, name, file, hashes: [hash], returns: 0, lastAt: at });
        this.cap(this.edited);
        return;
      }
      e = { id, name, file, hashes: [], returns: 0, lastAt: at };
      this.edited.set(id, e);
      this.cap(this.edited);
    }
    const last = e.hashes[e.hashes.length - 1];
    if (last === hash) return;
    if (!edit) return; // a re-serve of a changed symbol is not an edit; the edit path records it
    if (e.hashes.includes(hash)) e.returns++;
    e.hashes.push(hash);
    if (e.hashes.length > 64) e.hashes.splice(0, e.hashes.length - 64);
    e.lastAt = at;
  }

  /**
   * At a tool call: sample the tracked files that changed on disk (unless the watcher already feeds
   * versions), then compute the facts. Files are stat-ed, and only changed ones re-hashed.
   */
  async refresh(): Promise<void> {
    await this.enqueue(async () => {
      const files = new Set<string>([...this.served.values()].map(s => s.file));
      if (this.editSource === 'sampled') for (const e of this.edited.values()) files.add(e.file);
      for (const file of files) {
        const m = await this.mtime(file);
        if (m === this.seenMtime.get(file)) continue;
        if (this.editSource === 'watcher' && !this.isServedFile(file)) continue;
        const content = await this.readCurrent(file);
        if (content === undefined) { this.untracked.add(file); this.seenMtime.set(file, m); continue; }
        await this.observe(file, content);
      }
      // Each tool call keeps the persisted ledger current, so other processes see a live session.
      if (this.served.size || this.edited.size) this.scheduleWrite();
    });
  }

  private isServedFile(file: string): boolean {
    for (const s of this.served.values()) if (s.file === file) return true;
    return false;
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
      const current = e?.hashes[e.hashes.length - 1];
      if (!e || current === undefined || current === s.hash) continue;
      // The agent's own edit: its after-edit hook reported this file after the symbol was served.
      if (agentEdits.some(a => a.file === s.file && a.at >= s.servedAt)) continue;
      backgroundChanges.push({ id: s.id, name: s.name, file: s.file, servedAt: new Date(s.servedAt).toISOString(), changedAt: new Date(e.lastAt).toISOString() });
    }
    const editOscillation: EditOscillation[] = [];
    for (const e of this.edited.values()) {
      if (e.returns < OSCILLATION_RETURNS) continue;
      editOscillation.push({ id: e.id, name: e.name, file: e.file, returns: e.returns, cycle: e.hashes.slice(-6) });
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
   */
  takeNote(agentEdits?: Array<{ file: string; at: number }>): string | null {
    const f = this.facts(agentEdits);
    const lines: string[] = [];
    const fresh = f.backgroundChanges.filter(c => !this.delivered.has(`${c.id}@${this.edited.get(c.id)?.hashes.at(-1)}`));
    if (fresh.length) {
      const named = fresh.slice(0, MAX_NAMED).map(c => `${c.name} (${c.file}) — its body changed since you read it at ${hhmm(Date.parse(c.servedAt))}`);
      lines.push(`Served earlier: ${named.join('; ')}${fresh.length > MAX_NAMED ? `; and ${fresh.length - MAX_NAMED} more` : ''}.`);
      for (const c of fresh) this.delivered.add(`${c.id}@${this.edited.get(c.id)?.hashes.at(-1)}`);
    }
    for (const o of f.editOscillation) {
      const key = `${o.id}#${o.returns}`;
      if (this.delivered.has(key)) continue;
      this.delivered.add(key);
      lines.push(`${o.name} (${o.file}) returned to an earlier version ${o.returns === 2 ? 'twice' : `${o.returns} times`} this session.`);
    }
    if (!lines.length) return null;
    return `[openlore freshness] ${lines.join(' ')} Informational signal.`;
  }

  /** Symbols newly in an edit loop since the last call (the panic layer's input). */
  takeNewOscillations(): EditOscillation[] {
    const out = this.facts([]).editOscillation.filter(o => !this.loopsSeen.has(`${o.id}#${o.returns}`));
    for (const o of out) this.loopsSeen.add(`${o.id}#${o.returns}`);
    return out;
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
      counts: { served: this.served.size, edited: [...this.edited.values()].filter(e => e.hashes.length > 1).length, untracked: this.untracked.size, dropped: this.dropped },
      backgroundChanges: f.backgroundChanges,
      editOscillation: f.editOscillation,
      ...(f.withheld ? { withheld: f.withheld } : {}),
    };
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = undefined;
      void this.persist();
    }, 500);
    this.writeTimer.unref?.();
  }

  /** Write the snapshot for other processes (atomic; failures are ignored). */
  async persist(): Promise<void> {
    try {
      await atomicWriteFile(join(ledgerDir(this.root), `${process.pid}.json`), JSON.stringify(this.snapshot(), null, 2) + '\n');
    } catch { /* advisory */ }
  }

  /** Remove this session's ledger (process exit). */
  dispose(): void {
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
      const snap = JSON.parse(readFileSync(join(ledgerDir(root), n), 'utf-8')) as LedgerSnapshot;
      if (snap?.schemaVersion !== 1 || typeof snap.pid !== 'number') continue;
      if (!alive(snap.pid) || now - Date.parse(snap.updatedAt) > LEDGER_EXPIRY_MS) continue;
      live.push(snap);
    } catch { /* a torn or foreign file is not a session */ }
  }
  if (live.length === 1) return { ledger: live[0] };
  return { withheld: live.length === 0
    ? 'No live OpenLore MCP server has a session ledger for this worktree.'
    : `${live.length} live OpenLore MCP servers have a session ledger for this worktree; their facts are not merged or chosen between.` };
}
