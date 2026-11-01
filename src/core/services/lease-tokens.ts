/**
 * Lease tokens: portable proof of what a response served (change: add-session-lease-tokens).
 *
 * `orient` and `recall` return a `leaseToken` naming the functions and files they served, with a
 * hash of their exact text at that moment. Any process on the same clone can later ask
 * `verify_claim` (`lease-current`) whether that text is still current — a sub-agent checking what its
 * parent read, or an agent after a pause.
 *
 * Issuing reads files and the cached index only (no parsing on the response path): a served function
 * is located by the index's span (file, name, start line), and its raw text is hashed along with its
 * first characters, so the check can find it again after edits above it. A served name the index
 * cannot locate (a class, a symbol not indexed) is listed as not covered, never compared at file
 * level. Whole files (specs) are hashed as text, whitespace-normalized for Markdown, YAML, and JSON.
 *
 * A token is a small JSON file in `.openlore/session-ledger/tokens/` (never committed), valid for
 * {@link LEASE_TTL_MS}. The check never writes; anything it cannot settle makes the claim unverifiable.
 */

import { createHash, randomBytes } from 'node:crypto';
import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { readFileConfined } from '../../utils/path-confinement.js';
import { OPENLORE_DIR } from '../../constants.js';

/** How long a token resolves. */
export const LEASE_TTL_MS = 12 * 3600 * 1000;
const MAX_ENTRIES = 200;
const MAX_TOKENS = 500;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const HEAD_CHARS = 80;
const TOKEN_RE = /^lt_[0-9a-f]{20}$/;
/** Text files whose formatting carries no meaning: hashed whitespace-normalized. */
const NORMALIZED = /\.(?:md|markdown|ya?ml|json)$/i;

export interface LeaseEntry {
  file: string;
  /** A served function: its name, span, raw-text hash, and first characters. */
  name?: string;
  start?: number;
  end?: number;
  hash?: string;
  head?: string;
  /** A served whole file: its text hash (whitespace-normalized for Markdown, YAML, JSON). */
  fileHash?: string;
}

interface LeaseRecord { version: 1; createdAt: string; entries: LeaseEntry[]; notCovered?: string[] }

export interface ServedItem { file: string; name?: string; startLine?: number }

/** The token directory, created (with the ledger's `.gitignore`) only when a token is written. */
const tokensDir = async (root: string) => {
  const { ensureLedgerDir } = await import('./session-ledger.js');
  return join(ensureLedgerDir(root), 'tokens');
};
/** The same directory for reading: a check never creates anything. */
const tokensDirForRead = (root: string) => join(root, OPENLORE_DIR, 'session-ledger', 'tokens');
const sha = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 20);
const fileTextHash = (file: string, text: string) => sha(NORMALIZED.test(file) ? text.replace(/\s+/g, ' ').trim() : text);

/** What a response served. */
export function servedForLease(tool: string, result: unknown): ServedItem[] {
  if (!result || typeof result !== 'object') return [];
  const r = result as Record<string, unknown>;
  const rows = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
  if (tool === 'orient') {
    return [
      ...rows(r.relevantFunctions).flatMap(f => (typeof f.filePath === 'string' && typeof f.name === 'string'
        ? [{ file: f.filePath, name: f.name, ...(typeof f.startLine === 'number' ? { startLine: f.startLine } : {}) }] : [])),
      ...rows(r.specDomains).flatMap(d => (typeof d.specFile === 'string' ? [{ file: d.specFile }] : [])),
    ];
  }
  if (tool === 'recall') {
    return rows(r.authoritative).flatMap(m => rows(m.anchors).flatMap(a =>
      typeof a.file === 'string' ? [{ file: a.file, ...(typeof a.symbol === 'string' ? { name: a.symbol } : {}) }] : []));
  }
  return [];
}

/** Issue a token for what a response served; undefined when nothing could be leased or it cannot be written. */
export async function issueLeaseToken(root: string, items: readonly ServedItem[]): Promise<string | undefined> {
  if (!items.length) return undefined;
  try {
    const { readCachedContext } = await import('./mcp-handlers/utils.js');
    const ctx = items.some(i => i.name) ? await readCachedContext(root) : null;
    const nodes = (ctx?.callGraph?.nodes ?? []) as Array<{ name: string; filePath: string; startLine?: number; startIndex?: number; endIndex?: number; isExternal?: boolean }>;
    const entries: LeaseEntry[] = [];
    const notCovered: string[] = [];
    const texts = new Map<string, string | null>();
    const textOf = async (file: string) => {
      if (!texts.has(file)) texts.set(file, await readFileConfined(root, file, MAX_FILE_BYTES).catch(() => null));
      return texts.get(file)!;
    };
    const seen = new Set<string>();
    for (const it of items.slice(0, MAX_ENTRIES)) {
      const key = `${it.file}\0${it.name ?? ''}\0${it.startLine ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = await textOf(it.file);
      if (text === null) { notCovered.push(it.name ? `${it.name} (${it.file})` : it.file); continue; }
      if (!it.name) { entries.push({ file: it.file, fileHash: fileTextHash(it.file, text) }); continue; }
      const candidates = nodes.filter(n => !n.isExternal && n.filePath === it.file && n.name === it.name && typeof n.startIndex === 'number' && typeof n.endIndex === 'number');
      const node = candidates.length === 1 ? candidates[0] : candidates.find(n => n.startLine === it.startLine);
      const span = node ? text.slice(node.startIndex, node.endIndex) : '';
      if (!node || !span) { notCovered.push(`${it.name} (${it.file})`); continue; }
      entries.push({ file: it.file, name: it.name, start: node.startIndex, end: node.endIndex, hash: sha(span), head: span.slice(0, HEAD_CHARS) });
    }
    if (!entries.length) return undefined;
    const token = `lt_${randomBytes(10).toString('hex')}`;
    const dir = await tokensDir(root);
    await atomicWriteFile(join(dir, `${token}.json`), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), entries, ...(notCovered.length ? { notCovered } : {}) } satisfies LeaseRecord));
    prune(dir);
    return token;
  } catch {
    return undefined;
  }
}

/** Drop expired tokens and keep at most {@link MAX_TOKENS} (newest kept). */
function prune(dir: string): void {
  try {
    const files = readdirSync(dir).filter(n => n.endsWith('.json')).map(n => ({ n, t: statSync(join(dir, n)).mtimeMs }));
    const cutoff = Date.now() - LEASE_TTL_MS;
    files.sort((a, b) => b.t - a.t).forEach((f, i) => { if (f.t < cutoff || i >= MAX_TOKENS) { try { unlinkSync(join(dir, f.n)); } catch { /* raced */ } } });
  } catch { /* best effort */ }
}

export type LeaseCheck =
  | { status: 'unknown' | 'expired'; reason: string }
  | {
    status: 'checked';
    createdAt: string;
    entries: number;
    changed: Array<{ file: string; name?: string; why: 'changed' | 'removed' }>;
    /** Entries the check could not settle (a file it could not read, other than a missing one). */
    unsettled: Array<{ file: string; name?: string; reason: string }>;
    notCovered: string[];
  };

const isEntry = (e: unknown): e is LeaseEntry => {
  const x = e as LeaseEntry | null;
  if (!x || typeof x.file !== 'string') return false;
  if (typeof x.fileHash === 'string' && x.name === undefined) return true;
  return typeof x.name === 'string' && typeof x.hash === 'string' && typeof x.head === 'string'
    && Number.isInteger(x.start) && Number.isInteger(x.end) && x.end! > x.start!;
};

/** Whether every entry of a token still has the same text. */
export async function checkLease(root: string, token: string): Promise<LeaseCheck> {
  if (!TOKEN_RE.test(token)) return { status: 'unknown', reason: `"${token.slice(0, 40)}" is not a lease token (expected lt_ followed by 20 hex characters).` };
  let rec: LeaseRecord;
  try {
    rec = JSON.parse(await readFileConfined(tokensDirForRead(root), `${token}.json`, 512 * 1024, true)) as LeaseRecord;
  } catch {
    return { status: 'unknown', reason: `No lease ${token} is recorded in this clone: it was issued elsewhere, has been pruned, or is mistyped.` };
  }
  const created = Date.parse(rec?.createdAt);
  const raw = Array.isArray(rec?.entries) ? rec.entries : [];
  const entries = raw.filter(isEntry).slice(0, MAX_ENTRIES);
  if (rec?.version !== 1 || !Number.isFinite(created) || created > Date.now() + 60_000 || !entries.length || entries.length !== Math.min(raw.length, MAX_ENTRIES)) {
    // A malformed entry is never silently skipped: the whole token is unreadable.
    return { status: 'unknown', reason: `Lease ${token} is unreadable.` };
  }
  if (Date.now() - created > LEASE_TTL_MS) return { status: 'expired', reason: `Lease ${token} expired (issued ${rec.createdAt}; leases last ${LEASE_TTL_MS / 3600000} hours).` };
  const changed: Extract<LeaseCheck, { status: 'checked' }>['changed'] = [];
  const unsettled: Extract<LeaseCheck, { status: 'checked' }>['unsettled'] = [];
  const texts = new Map<string, { text?: string; missing?: boolean; error?: string }>();
  for (const e of entries) {
    if (!texts.has(e.file)) {
      try { texts.set(e.file, { text: await readFileConfined(root, e.file, MAX_FILE_BYTES) }); } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        texts.set(e.file, code === 'ENOENT' ? { missing: true } : { error: code ?? (err instanceof Error ? err.message.split('\n')[0] : String(err)) });
      }
    }
    const t = texts.get(e.file)!;
    const ref = { file: e.file, ...(e.name ? { name: e.name } : {}) };
    if (t.missing) { changed.push({ ...ref, why: 'removed' }); continue; }
    if (t.text === undefined) { unsettled.push({ ...ref, reason: `the file could not be read (${t.error})` }); continue; }
    if (e.name === undefined) { if (fileTextHash(e.file, t.text) !== e.fileHash) changed.push({ ...ref, why: 'changed' }); continue; }
    // The same text at its span, or anywhere its first characters now appear (an edit above it).
    const len = e.end! - e.start!;
    let same = sha(t.text.slice(e.start, e.end)) === e.hash;
    for (let at = same ? -1 : t.text.indexOf(e.head!), tries = 0; at !== -1 && tries < 64 && !same; at = t.text.indexOf(e.head!, at + 1), tries++) {
      same = sha(t.text.slice(at, at + len)) === e.hash;
    }
    if (!same) changed.push({ ...ref, why: 'changed' });
  }
  return { status: 'checked', createdAt: rec.createdAt, entries: entries.length, changed, unsettled, notCovered: Array.isArray(rec.notCovered) ? rec.notCovered.filter(x => typeof x === 'string').slice(0, 50) : [] };
}
