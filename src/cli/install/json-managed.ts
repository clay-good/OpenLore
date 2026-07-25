/**
 * Safe merge of an OpenLore-managed entry into a JSON config file.
 *
 * We store our additions under a top-level `_openlore` key for bookkeeping
 * (fingerprint of the merged subtree, version), while writing the actual
 * config under whatever path the host tool reads (e.g. `mcpServers.openlore`,
 * `hooks.SessionStart`). The fingerprint lets us detect hand-edits.
 */

import { createHash } from 'node:crypto';
import { isProtoPollutingKey } from '../../utils/misc.js';
import { modify, applyEdits, type FormattingOptions } from 'jsonc-parser';

/** A minimal edit into an existing JSON document: set `path` to `value`, or delete it when `value` is undefined. */
export interface JsonPathEdit {
  path: (string | number)[];
  value: unknown;
}

/** Infer indent unit + line ending from an existing JSON file so edits match the user's style. */
export function detectJsonFormatting(text: string): FormattingOptions {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  // First indented content line reveals the unit (tabs or N spaces).
  const m = text.match(/\n([ \t]+)\S/);
  if (m) {
    const ws = m[1];
    if (ws.startsWith('\t')) return { tabSize: 1, insertSpaces: false, eol };
    return { tabSize: ws.length, insertSpaces: true, eol };
  }
  return { tabSize: 2, insertSpaces: true, eol };
}

/**
 * Apply path edits to an existing JSON document's TEXT, preserving the formatting of every
 * region OpenLore does not touch (indent style, key order, spacing, untouched values). Only
 * the edited paths are re-rendered, using formatting detected from the original. This replaces
 * reparse→`JSON.stringify` writes, which reformat the user's whole file (decision df27e8ef).
 */
export function editJsonPreservingFormat(originalText: string, edits: JsonPathEdit[]): string {
  const formattingOptions = detectJsonFormatting(originalText);
  let text = originalText;
  for (const { path, value } of edits) {
    // modify() with value === undefined removes the property; a no-op (e.g. deleting an absent
    // path) returns no edits, so every edit is safe to attempt unconditionally.
    const e = modify(text, path, value, { formattingOptions });
    text = applyEdits(text, e);
  }
  return text;
}

export interface ManagedJsonMeta {
  managed: true;
  version: number;
  fingerprint: string;
  /**
   * Dotted paths into the JSON document that OpenLore manages. Used by
   * `--uninstall` to remove only what we added.
   */
  paths: string[];
}

const META_KEY = '_openlore';
const META_VERSION = 1;

export function canonicalJsonHash(value: unknown): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex').slice(0, 16);
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}

export interface ManagedEntry {
  /** Dotted path into the JSON document (e.g. "mcpServers.openlore"). */
  path: string;
  /** Value to write at that path. */
  value: unknown;
}

export interface MergeResult {
  next: Record<string, unknown>;
  action: 'created' | 'updated' | 'noop';
  /** If the existing meta fingerprint didn't match what was on disk. */
  handEdited: boolean;
}

export function readMeta(doc: Record<string, unknown>): ManagedJsonMeta | null {
  const meta = doc[META_KEY];
  if (!meta || typeof meta !== 'object') return null;
  const m = meta as Record<string, unknown>;
  if (m.managed !== true || typeof m.fingerprint !== 'string') return null;
  return {
    managed: true,
    version: typeof m.version === 'number' ? m.version : 1,
    fingerprint: m.fingerprint,
    paths: Array.isArray(m.paths) ? (m.paths.filter((p) => typeof p === 'string') as string[]) : [],
  };
}

/**
 * A managed path taken from the DOCUMENT rather than from our own constants.
 *
 * `_openlore.paths` is read back off disk, so it is user-editable data, not a value
 * this code chose. It can therefore name a prototype-polluting path — and OpenLore
 * never writes one, so such an entry cannot describe anything we manage. Dropping it
 * is the correct reading; `setPath`/`deletePath` still throw for internal callers,
 * where an unsafe path would be a programmer error rather than untrusted input.
 */
function managedPathsFrom(meta: ManagedJsonMeta): string[] {
  return meta.paths.filter((p) => !p.split('.').some(isProtoPollutingKey));
}

/**
 * Verify the meta fingerprint still matches the values we previously wrote.
 * If not, the user has hand-edited one of our managed paths.
 */
export function isHandEdited(doc: Record<string, unknown>, meta: ManagedJsonMeta): boolean {
  const subset: Record<string, unknown> = {};
  for (const path of managedPathsFrom(meta)) {
    const value = getPath(doc, path);
    if (value !== undefined) setPath(subset, path, value);
  }
  return canonicalJsonHash(subset) !== meta.fingerprint;
}

export function mergeEntries(
  existing: Record<string, unknown>,
  entries: ManagedEntry[]
): MergeResult {
  const next = structuredClone(existing) as Record<string, unknown>;
  const prevMeta = readMeta(next);
  const handEdited = prevMeta ? isHandEdited(next, prevMeta) : false;

  for (const e of entries) setPath(next, e.path, e.value);

  const subset: Record<string, unknown> = {};
  for (const e of entries) setPath(subset, e.path, e.value);

  const newMeta: ManagedJsonMeta = {
    managed: true,
    version: META_VERSION,
    fingerprint: canonicalJsonHash(subset),
    paths: entries.map((e) => e.path),
  };
  next[META_KEY] = newMeta;

  // Did anything actually change vs `existing`?
  const before = canonicalize(existing);
  const after = canonicalize(next);
  const action: MergeResult['action'] = prevMeta
    ? before === after
      ? 'noop'
      : 'updated'
    : 'created';

  return { next, action, handEdited };
}

export function removeManaged(doc: Record<string, unknown>): {
  next: Record<string, unknown>;
  removed: boolean;
} {
  const meta = readMeta(doc);
  if (!meta) return { next: doc, removed: false };
  const next = structuredClone(doc) as Record<string, unknown>;
  for (const path of managedPathsFrom(meta)) deletePath(next, path);
  delete next[META_KEY];
  return { next, removed: true };
}

// ---------- path helpers ----------

function getPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  // A `__proto__` / `constructor` / `prototype` segment would walk out of `obj` and
  // mutate the prototype chain instead, so every process that later reads an
  // unrelated object sees the injected value. Refuse rather than silently skip: a
  // caller asking to write that path is either confused or hostile, and these paths
  // are internal constants, so a throw can only surface a bug.
  if (parts.some(isProtoPollutingKey)) {
    throw new Error(`Refusing to write unsafe config path "${path}" (prototype-polluting segment)`);
  }
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const next = cur[k];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function deletePath(obj: Record<string, unknown>, path: string): void {
  const parts = path.split('.');
  // Same guard as setPath: `delete Object.prototype.x` is as damaging as writing it.
  if (parts.some(isProtoPollutingKey)) {
    throw new Error(`Refusing to delete unsafe config path "${path}" (prototype-polluting segment)`);
  }
  const chain: Array<{ container: Record<string, unknown>; key: string }> = [];
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    const next = cur[k];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) return;
    chain.push({ container: cur, key: k });
    cur = next as Record<string, unknown>;
  }
  delete cur[parts[parts.length - 1]];
  // Prune empty parent objects we walked through.
  for (let i = chain.length - 1; i >= 0; i--) {
    const { container, key } = chain[i];
    const child = container[key] as Record<string, unknown>;
    if (Object.keys(child).length === 0) delete container[key];
    else break;
  }
}
