/**
 * Lease tokens: portable proof of what a response served (change: add-session-lease-tokens).
 *
 * `orient` and `recall` return a `leaseToken` naming the set of (symbol or file, content hash) pairs
 * they served. Any process on the same clone can later ask `verify_claim` (`lease-current`) whether
 * that set is still current — a sub-agent checking what its parent read, or an agent after a pause.
 *
 * A token is a small JSON file in `.openlore/session-ledger/tokens/` (never committed), valid for
 * {@link LEASE_TTL_MS}. Symbol hashes are the index's own content hashes; a file whose symbols could
 * not be hashed in the time budget keeps a whole-file hash, and is then compared at file level.
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
const MAX_FILE_BYTES = 1024 * 1024;
const HASH_BUDGET_MS = 250;
const TOKEN_RE = /^lt_[0-9a-f]{20}$/;

export interface LeaseEntry {
  file: string;
  /** The symbol, when the entry is one; absent for a whole file. */
  name?: string;
  /** The symbol's content hash at issue (absent when it could not be hashed in time). */
  hash?: string;
  /** The whole file's hash at issue (whitespace-normalized text). */
  fileHash?: string;
}

interface LeaseRecord { version: 1; createdAt: string; entries: LeaseEntry[] }

/** The token directory, created (with the ledger's `.gitignore`) only when a token is written. */
const tokensDir = async (root: string) => {
  const { ensureLedgerDir } = await import('./session-ledger.js');
  return join(ensureLedgerDir(root), 'tokens');
};
/** The same directory for reading: a check never creates anything. */
const tokensDirForRead = (root: string) => join(root, OPENLORE_DIR, 'session-ledger', 'tokens');
const wholeHash = (text: string) => createHash('sha256').update(text.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 16);

/** What a response served, as (file, symbol?) pairs. */
export function servedForLease(tool: string, result: unknown): Array<{ file: string; name?: string }> {
  if (!result || typeof result !== 'object') return [];
  const r = result as Record<string, unknown>;
  const rows = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is Record<string, unknown> => !!x && typeof x === 'object') : []);
  if (tool === 'orient') {
    return [
      ...rows(r.relevantFunctions).flatMap(f => (typeof f.filePath === 'string' && typeof f.name === 'string' ? [{ file: f.filePath, name: f.name }] : [])),
      ...rows(r.specDomains).flatMap(d => (typeof d.specFile === 'string' ? [{ file: d.specFile }] : [])),
    ];
  }
  if (tool === 'recall') {
    // The anchors of what recall served as authoritative.
    return rows(r.authoritative).flatMap(m => rows(m.anchors).flatMap(a =>
      typeof a.file === 'string' ? [{ file: a.file, ...(typeof a.symbol === 'string' ? { name: a.symbol } : {}) }] : []));
  }
  return [];
}

/** Hash the served items now: symbols by the index's content hash, every file as a whole. */
async function hashItems(root: string, items: ReadonlyArray<{ file: string; name?: string }>, budgetMs: number): Promise<LeaseEntry[]> {
  const { hashFileSymbols } = await import('./session-ledger.js');
  const deadline = Date.now() + budgetMs;
  const byFile = new Map<string, Set<string | undefined>>();
  for (const it of items.slice(0, MAX_ENTRIES)) (byFile.get(it.file) ?? byFile.set(it.file, new Set()).get(it.file)!).add(it.name);
  const out: LeaseEntry[] = [];
  for (const [file, names] of [...byFile].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let text: string | undefined;
    try { text = await readFileConfined(root, file, MAX_FILE_BYTES); } catch { text = undefined; }
    const fileHash = text === undefined ? undefined : wholeHash(text);
    const symbols = text !== undefined && Date.now() < deadline && [...names].some(Boolean) ? await hashFileSymbols(file, text) : undefined;
    for (const name of [...names].sort()) {
      if (!name) { out.push({ file, ...(fileHash ? { fileHash } : {}) }); continue; }
      const hashes = symbols ? [...symbols.values()].filter(s => s.name === name).map(s => s.hash) : [];
      out.push({ file, name, ...(hashes.length ? { hash: hashes.sort().join('+') } : {}), ...(fileHash ? { fileHash } : {}) });
    }
  }
  // An entry with no hash at all could never be checked: it is not part of the lease.
  return out.filter(e => e.hash || e.fileHash);
}

/** Issue a token for what a response served; undefined when nothing was served or it cannot be written. */
export async function issueLeaseToken(root: string, items: ReadonlyArray<{ file: string; name?: string }>, budgetMs = HASH_BUDGET_MS): Promise<string | undefined> {
  if (!items.length) return undefined;
  try {
    const entries = await hashItems(root, items, budgetMs);
    if (!entries.length) return undefined;
    const token = `lt_${randomBytes(10).toString('hex')}`;
    const dir = await tokensDir(root);
    await atomicWriteFile(join(dir, `${token}.json`), JSON.stringify({ version: 1, createdAt: new Date().toISOString(), entries } satisfies LeaseRecord));
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
    const sorted = files.sort((a, b) => b.t - a.t);
    sorted.forEach((f, i) => { if (f.t < cutoff || i >= MAX_TOKENS) { try { unlinkSync(join(dir, f.n)); } catch { /* raced */ } } });
  } catch { /* best effort */ }
}

export type LeaseCheck =
  | { status: 'unknown' | 'expired'; reason: string }
  | { status: 'checked'; createdAt: string; entries: number; changed: Array<{ file: string; name?: string; why: 'changed' | 'removed' | 'file-changed' }> };

/** Whether every entry of a token still hashes the same. */
export async function checkLease(root: string, token: string): Promise<LeaseCheck> {
  if (!TOKEN_RE.test(token)) return { status: 'unknown', reason: `"${token.slice(0, 40)}" is not a lease token (expected lt_ followed by 20 hex characters).` };
  let rec: LeaseRecord;
  try {
    rec = JSON.parse(await readFileConfined(tokensDirForRead(root), `${token}.json`, 512 * 1024, true)) as LeaseRecord;
  } catch {
    return { status: 'unknown', reason: `No lease ${token} is recorded in this clone: it was issued elsewhere, has been pruned, or is mistyped.` };
  }
  const created = Date.parse(rec?.createdAt);
  if (rec?.version !== 1 || !Array.isArray(rec.entries) || !Number.isFinite(created)) return { status: 'unknown', reason: `Lease ${token} is unreadable.` };
  if (Date.now() - created > LEASE_TTL_MS) return { status: 'expired', reason: `Lease ${token} expired (issued ${rec.createdAt}; leases last ${LEASE_TTL_MS / 3600000} hours).` };
  const entries = rec.entries.filter((e): e is LeaseEntry => !!e && typeof e.file === 'string').slice(0, MAX_ENTRIES);
  const { hashFileSymbols } = await import('./session-ledger.js');
  const changed: Extract<LeaseCheck, { status: 'checked' }>['changed'] = [];
  const byFile = new Map<string, LeaseEntry[]>();
  for (const e of entries) (byFile.get(e.file) ?? byFile.set(e.file, []).get(e.file)!).push(e);
  for (const [file, list] of byFile) {
    let text: string | undefined;
    try { text = await readFileConfined(root, file, MAX_FILE_BYTES); } catch { text = undefined; }
    if (text === undefined) { for (const e of list) changed.push({ file, ...(e.name ? { name: e.name } : {}), why: 'removed' }); continue; }
    const fileHash = wholeHash(text);
    const symbols = list.some(e => e.name && e.hash) && fileHash !== list[0].fileHash ? await hashFileSymbols(file, text) : undefined;
    for (const e of list) {
      if (e.fileHash && e.fileHash === fileHash) continue; // the file is unchanged, so every entry in it is
      if (!e.name || !e.hash) { if (e.fileHash) changed.push({ file, ...(e.name ? { name: e.name } : {}), why: 'file-changed' }); continue; }
      const now = symbols ? [...symbols.values()].filter(s => s.name === e.name).map(s => s.hash) : [];
      if (!now.length) changed.push({ file, name: e.name, why: 'removed' });
      else if (now.sort().join('+') !== e.hash) changed.push({ file, name: e.name, why: 'changed' });
    }
  }
  return { status: 'checked', createdAt: rec.createdAt, entries: entries.length, changed };
}
