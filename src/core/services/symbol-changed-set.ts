/**
 * Symbol-level changed-sets between a base revision and the working tree
 * (change: add-symbol-content-hashes).
 *
 * `blast_radius`, `select_tests` and `briefing_since` used to seed from every production symbol in
 * every changed file. This module narrows that to the symbols that actually changed. Each changed
 * file is extracted twice with normalized content hashes, once at the base revision and once from the
 * working tree, and the two hash sets are compared: a symbol is `changed` when its hash differs,
 * `appeared` or `disappeared` when it exists on one side only. Only the files the diff names are ever
 * read, so the cost is bounded by the diff and never by the repository.
 *
 * Narrowing must never drop a symbol that file-level seeding would have caught for a reason that
 * still holds. A file therefore stays FILE-granular, with a named reason, whenever the evidence is
 * incomplete:
 *
 *  - either side could not be read, parsed cleanly, or hashed (`unreadable`, `parse-errors`,
 *    `language-not-hashed`, `span-not-contiguous`, `invalid-span`);
 *  - anything outside every symbol changed: an import, a module-level constant, a class field, or
 *    the order of the symbols (`module-level-change`);
 *  - the index does not match what the working tree extracts to (`index-mismatch`);
 *  - the diff names more files than the bound (`file-cap`).
 *
 * Inside a symbol-granular file, two more groups stay seeded because a same-file caller can reach a
 * changed symbol without a resolved edge: symbols whose text names a changed symbol (`referencing`),
 * and symbols that hold a dynamic-dispatch site (`dynamicDispatch`). Cross-file effects are no worse
 * than file-level seeding, which never seeded other files either.
 *
 * A disappeared/appeared pair that symbol-identity continuity (`analyzer/continuity.ts`) matches is
 * also reported as a carried rename or move. Both ids stay in the seed set.
 */

import type { ChangedFile } from '../../types/index.js';
import type { FunctionNode, SerializedCallGraph } from '../analyzer/call-graph.js';
import { extractFileWithContentHashes } from '../analyzer/call-graph.js';
import type { FileExtractResult } from '../analyzer/call-graph-types.js';
import type { ImportStatementHash } from '../analyzer/symbol-content-hash.js';
import { detectLanguage } from '../analyzer/language-detection.js';
import { languageSupport } from '../analyzer/language-support.js';
import {
  computeContinuity,
  normalizedBodyHash,
  type AppearedSymbol,
  type ContinuityPair,
  type DisappearedSymbol,
} from '../analyzer/continuity.js';
import { hashSpan } from '../decisions/anchor.js';
import { getRepoPrefix, reframeRepoPath, resolveBaseRef } from '../drift/git-diff.js';
import { execFileGit, spawnGit } from '../../utils/git-exec.js';
import { readFileConfined, safeJoin } from '../../utils/path-confinement.js';
import { lstat } from 'node:fs/promises';
import { SOURCE_SCAN_MAX_FILE_BYTES } from '../../constants.js';

/**
 * Most changed files hashed per call. Each costs two reads and two parses. A diff that names more
 * code files than this keeps the rest file-granular (`file-cap`), which is today's behavior and is
 * disclosed. A cost bound, not a change-detection threshold: detection is hash equality only.
 */
export const MAX_SYMBOL_HASHED_FILES = 200;

/**
 * Cumulative source bytes (both revisions) hashed per call. The file bound alone says nothing about
 * cost — 200 large files parse far longer than 200 small ones — so the byte bound is what keeps the
 * worst case bounded. Deterministic (files are read in path order), and disclosed as `size-cap`.
 */
export const MAX_SYMBOL_HASHED_BYTES = 1024 * 1024;

/**
 * Largest single file hashed. A file this big is parsed twice, and its parse dominates the call's
 * cost; a diff that touches one is better served whole (`size-cap`) than by a briefing that takes
 * a minute. Deterministic and disclosed, like every other bound here.
 */
export const MAX_SYMBOL_HASHED_FILE_BYTES = 256 * 1024;

/**
 * Wall-clock the hashing pass may spend before the remaining files keep file granularity
 * (`time-cap`). Bytes are a poor proxy for parse cost — a file of 900 tiny functions parses far
 * slower than one function of the same size — and these tools run in a pre-commit hook and an agent
 * turn, where minutes are not available. Like the analyzer's per-file parse budget, this trades
 * PRECISION for a bounded answer: the degraded direction is always the conservative one (the whole
 * file counts as changed), so a slow machine can only ever seed MORE, never fewer, and the receipt
 * names every file it skipped.
 */
export const SYMBOL_HASHING_BUDGET_MS = 8_000;

/** Base blobs read concurrently. Each is a `git cat-file` spawn; the byte bound caps what is held. */
const READ_CONCURRENCY = 8;

/** Per-read git timeout. A slow read falls back to file granularity; it never blocks the tool. */
const GIT_READ_TIMEOUT_MS = 10_000;

/** Why a changed file keeps file-level granularity. A closed vocabulary. */
export type FileGranularityReason =
  | 'language-not-hashed'
  | 'parse-errors'
  | 'module-level-change'
  | 'module-level-reference'
  | 'span-not-contiguous'
  | 'invalid-span'
  | 'unreadable'
  | 'index-mismatch'
  | 'file-cap'
  | 'size-cap'
  | 'time-cap'
  | 'not-assessed';

export const FILE_GRANULARITY_REASONS: Record<FileGranularityReason, string> = {
  'language-not-hashed': 'the language has no native parse tree to hash (no extractor, a WASM grammar, or a script container)',
  'parse-errors': 'one side has parse errors, so its tree is not trustworthy evidence',
  'module-level-change': 'code outside every symbol changed (imports, module-level statements, class fields), or moved across a symbol',
  'module-level-reference': 'module-level code names a changed symbol, so it may reach it through a binding no call edge records',
  'span-not-contiguous': 'a symbol span does not map to one contiguous run of the parse tree',
  'invalid-span': 'a symbol span lies outside its file',
  'unreadable': 'one side could not be read (missing blob, over the size bound, or a failed read)',
  'index-mismatch': 'the index lists symbols in this file that neither revision extracts to (re-run analyze)',
  'file-cap': `the diff names more than ${MAX_SYMBOL_HASHED_FILES} code files; the rest are not hashed`,
  'time-cap': `hashing spent its ${Math.round(SYMBOL_HASHING_BUDGET_MS / 1000)}s budget before reaching this file; the rest are not hashed`,
  'size-cap': `the file is larger than ${Math.round(MAX_SYMBOL_HASHED_FILE_BYTES / 1024)} KB, or the diff's code files exceed the ${Math.round(MAX_SYMBOL_HASHED_BYTES / 1024)} KB hashing budget`,
  'not-assessed': 'the diff path did not map onto this indexed file exactly, or the changed-set could not be computed',
};

export interface SymbolGranularChange {
  granularity: 'symbol';
  /** Present on both sides with a different normalized hash. */
  changed: string[];
  /** Present only in the working tree. */
  appeared: string[];
  /** Present only at the base revision. */
  disappeared: string[];
  /** Unchanged symbols whose text names a changed, appeared, or disappeared symbol. */
  referencing: string[];
  /** Unchanged symbols that hold a dynamic-dispatch site the resolver cannot follow. */
  dynamicDispatch: string[];
  /**
   * Module-level code outside the imports is identical, and the imports gained bindings the file did
   * not have. Present so a consumer can disclose the one thing this narrowing does not attribute to
   * the file's other symbols: the load-time side effects of the newly imported module.
   */
  importsAdded?: true;
}

export interface FileGranularChange {
  granularity: 'file';
  reason: FileGranularityReason;
}

export type FileSymbolChange = SymbolGranularChange | FileGranularChange;

export interface CarriedSymbol {
  from: string;
  to: string;
  reason: ContinuityPair['reason'];
  basis: ContinuityPair['basis'];
}

export interface SymbolChangedSet {
  /** The base revision this set was computed against, so a reusing caller can check it matches. */
  baseRef?: string;
  /** Keyed by the analyzed-root-relative path the index uses. */
  byFile: Map<string, FileSymbolChange>;
  /** Renames and moves continuity matched, sorted by `from`. */
  carried: CarriedSymbol[];
}

/** Entry shape the consumers already hold: `getChangedFiles` output. */
export type DiffEntry = Pick<ChangedFile, 'path' | 'status' | 'oldPath'>;

interface Side {
  present: boolean;
  content: string;
  result?: FileExtractResult;
}

/** The commit old content is read from: the merge base (as `base...HEAD` diffs), else the base. */
async function diffBaseCommit(absDir: string, resolvedBase: string): Promise<string> {
  try {
    const { stdout } = await execFileGit('git', ['merge-base', resolvedBase, 'HEAD'], { cwd: absDir, timeout: GIT_READ_TIMEOUT_MS });
    const sha = String(stdout).trim();
    if (/^[0-9a-f]{40,64}$/.test(sha)) return sha;
  } catch { /* no common ancestor: git diffed base..HEAD */ }
  return resolvedBase;
}

async function readBase(absDir: string, key: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileGit('git', ['cat-file', 'blob', key], {
      cwd: absDir,
      timeout: GIT_READ_TIMEOUT_MS,
      maxBuffer: SOURCE_SCAN_MAX_FILE_BYTES,
      encoding: 'utf-8',
    });
    return String(stdout);
  } catch {
    return undefined;
  }
}

async function readHead(absDir: string, localPath: string): Promise<string | undefined> {
  try {
    return await readFileConfined(absDir, localPath, SOURCE_SCAN_MAX_FILE_BYTES);
  } catch {
    return undefined;
  }
}

/**
 * Blob sizes for `<commit>:<path>` keys, in ONE `git cat-file --batch-check` rather than a spawn per
 * file. A key git cannot resolve is simply absent from the result.
 */
async function batchBlobSizes(absDir: string, keys: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (keys.length === 0) return out;
  const child = spawnGit('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    cwd: absDir, stdio: ['pipe', 'pipe', 'ignore'],
  });
  let stdout = '';
  child.stdout?.setEncoding('utf-8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  const done = new Promise<void>(resolve => {
    child.on('close', () => resolve());
    child.on('error', () => resolve());
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), GIT_READ_TIMEOUT_MS);
  try {
    // A key with a newline in it would desynchronize the stream, so it is never sent.
    const sendable = keys.filter(key => !/[\r\n]/.test(key));
    child.stdin?.end(sendable.map(key => `${key}\n`).join(''));
    await done;
    const lines = stdout.split('\n').filter(line => line.length > 0);
    for (const [i, line] of lines.entries()) {
      const parts = line.split(' ');
      if (parts.length !== 3 || parts[1] !== 'blob') continue;
      const size = Number(parts[2]);
      if (Number.isFinite(size) && sendable[i] !== undefined) out.set(sendable[i], size);
    }
  } catch {
    // No sizes: every file then reads as unknown-size, which the caller treats as 0 and reads.
  } finally {
    clearTimeout(timer);
  }
  return out;
}

/** Every id's hashes on one side, in document order, joined — a twin id changes if either twin does. */
function hashesById(result: FileExtractResult): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of result.contentHashes!.symbols) out.set(s.id, out.has(s.id) ? `${out.get(s.id)}+${s.hash}` : s.hash);
  return out;
}

/**
 * The file's shape projected onto what both revisions have: residual runs (`T:<count>`), the shared
 * symbols' runs, and the imports they share, with runs that adjoin after a dropped entry summed.
 * Equal projections mean nothing at module level moved across a symbol or an import; adding or
 * removing a symbol, or adding an import, never changes it.
 */
function projectLayout(
  layout: readonly string[],
  shared: ReadonlySet<string>,
  sharedImports: ReadonlyMap<string, number>,
): string {
  const out: string[] = [];
  const importBudget = new Map(sharedImports);
  for (const entry of layout) {
    if (entry.startsWith('S:')) {
      if (!shared.has(entry.slice(2))) continue;   // a symbol only one revision has
      out.push(entry);
      continue;
    }
    if (entry.startsWith('I:')) {
      // Keep the imports both revisions have, in order: an ADDED import is dropped like an added
      // symbol, while one that MOVED lands between different neighbours and the projections differ.
      const left = importBudget.get(entry.slice(2)) ?? 0;
      if (left === 0) continue;
      importBudget.set(entry.slice(2), left - 1);
      out.push(entry);
      continue;
    }
    const last = out[out.length - 1];
    if (last !== undefined && last.startsWith('T:')) out[out.length - 1] = `T:${Number(last.slice(2)) + Number(entry.slice(2))}`;
    else out.push(entry);
  }
  return out.join('\u0000');
}

/** Every symbol's span text, indexed once per side rather than re-scanned per symbol. */
function spanTextsById(side: Side): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const n of side.result?.nodes ?? []) {
    (out.get(n.id) ?? out.set(n.id, []).get(n.id)!).push(side.content.slice(n.startIndex, n.endIndex));
  }
  return out;
}

/** Import statements in `a` that `b` does not have, as a multiset difference by hash. */
function diffImports(a: readonly ImportStatementHash[], b: readonly ImportStatementHash[]): ImportStatementHash[] {
  const remaining = new Map<string, number>();
  for (const i of b) remaining.set(i.hash, (remaining.get(i.hash) ?? 0) + 1);
  const out: ImportStatementHash[] = [];
  for (const i of a) {
    const left = remaining.get(i.hash) ?? 0;
    if (left > 0) remaining.set(i.hash, left - 1);
    else out.push(i);
  }
  return out;
}

/** How many copies of each import statement BOTH revisions have. */
function sharedImportCounts(
  a: readonly ImportStatementHash[],
  b: readonly ImportStatementHash[],
): Map<string, number> {
  const count = (xs: readonly ImportStatementHash[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const i of xs) m.set(i.hash, (m.get(i.hash) ?? 0) + 1);
    return m;
  };
  const left = count(a);
  const right = count(b);
  const out = new Map<string, number>();
  for (const [hash, n] of left) {
    const shared = Math.min(n, right.get(hash) ?? 0);
    if (shared > 0) out.set(hash, shared);
  }
  return out;
}

/** Every whole identifier in a text, as a set. One scan, whatever the number of names of interest. */
function identifiersIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const match of text.matchAll(IDENTIFIER_RE)) out.add(match[0]);
  return out;
}

const IDENTIFIER_RE = /[\p{L}_$][\p{L}\p{N}_$]*/gu;

function sideUsable(side: Side): FileGranularityReason | undefined {
  if (!side.present) return undefined;
  const r = side.result;
  if (!r || r.grammarUnavailable || r.grammarUnavailableAll?.length || !r.contentHashes) return 'language-not-hashed';
  if (r.parseHealth) return 'parse-errors';
  if (r.contentHashes.residualUnavailable) return r.contentHashes.residualUnavailable;
  return undefined;
}

/** The file's text outside every symbol span: module-level code, imports, class bodies. */
function residualText(side: Side): string {
  if (!side.present || !side.result) return '';
  const spans = [...side.result.nodes]
    .map(n => [n.startIndex, n.endIndex] as const)
    .sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  for (const [start, end] of spans) {
    if (start > cursor) out += side.content.slice(cursor, start);
    cursor = Math.max(cursor, end);
  }
  return out + side.content.slice(cursor);
}

/** Compare one file's two sides. `indexIds` are the index's production symbols in the file. */
function compareFile(base: Side, head: Side, indexIds: string[]): FileSymbolChange {
  const reason = sideUsable(base) ?? sideUsable(head);
  if (reason) return { granularity: 'file', reason };
  /** Names the head revision imports and the base did not: a symbol naming one may now mean it. */
  let importedNames = new Set<string>();

  const baseHashes = base.present ? hashesById(base.result!) : new Map<string, string>();
  const headHashes = head.present ? hashesById(head.result!) : new Map<string, string>();
  let importsAdded = false;
  if (base.present && head.present) {
    if (base.result!.contentHashes!.residual !== head.result!.contentHashes!.residual) {
      return { granularity: 'file', reason: 'module-level-change' };
    }
    const shared = new Set([...baseHashes.keys()].filter(id => headHashes.has(id)));
    const sharedImports = sharedImportCounts(base.result!.contentHashes!.imports, head.result!.contentHashes!.imports);
    if (projectLayout(base.result!.contentHashes!.layout, shared, sharedImports)
        !== projectLayout(head.result!.contentHashes!.layout, shared, sharedImports)) {
      return { granularity: 'file', reason: 'module-level-change' };
    }
    const added = diffImports(head.result!.contentHashes!.imports, base.result!.contentHashes!.imports);
    const removed = diffImports(base.result!.contentHashes!.imports, head.result!.contentHashes!.imports);
    // A removed or rewritten import REBINDS a name the file's existing symbols may use — module-level
    // change. A bare side-effect import (binds nothing, runs code) is one too. Purely additive,
    // name-binding imports are not: nothing an existing symbol referred to changed meaning.
    if (removed.length > 0 || added.some(i => !i.binds)) {
      return { granularity: 'file', reason: 'module-level-change' };
    }
    importedNames = new Set(added.flatMap(i => i.names));
    importsAdded = added.length > 0;
  }
  if (indexIds.some(id => !baseHashes.has(id) && !headHashes.has(id))) {
    return { granularity: 'file', reason: 'index-mismatch' };
  }

  const changed = [...headHashes].filter(([id, h]) => baseHashes.has(id) && baseHashes.get(id) !== h).map(([id]) => id);
  const appeared = [...headHashes.keys()].filter(id => !baseHashes.has(id));
  const disappeared = [...baseHashes.keys()].filter(id => !headHashes.has(id));
  const moved = new Set([...changed, ...appeared, ...disappeared]);

  const names = new Set<string>();
  for (const side of [base, head]) {
    for (const n of side.result?.nodes ?? []) if (moved.has(n.id)) names.add(n.name);
  }
  // Module-level code that NAMES a changed symbol may bind it (`const h = get;`, a handler table)
  // and hand it to a sibling that never spells the name. The residual is unchanged here, so the
  // binding itself is invisible; keep the whole file rather than guess which sibling reaches it.
  // One pass over each text collecting its identifiers, intersected with the names of interest —
  // never a regex per (symbol, name) pair, which is quadratic on a file with many changed symbols.
  const wanted = new Set([...names, ...importedNames].filter(n => n.length > 0));
  if (base.present && head.present && names.size > 0) {
    const moduleNames = identifiersIn(`${residualText(base)}\n${residualText(head)}`);
    if ([...names].some(name => moduleNames.has(name))) {
      // Module-level code that NAMES a changed symbol may bind it (`const h = get;`, a handler
      // table) and hand it to a sibling that never spells the name.
      return { granularity: 'file', reason: 'module-level-reference' };
    }
  }
  const referencing = new Set<string>();
  const dynamicDispatch = new Set<string>();
  const all = new Set([...baseHashes.keys(), ...headHashes.keys()]);
  const textsById = [spanTextsById(base), spanTextsById(head)];
  if (wanted.size > 0) {
    for (const id of all) {
      if (moved.has(id)) continue;
      const texts = textsById.flatMap(index => index.get(id) ?? []);
      if (texts.some(text => {
        for (const identifier of identifiersIn(text)) if (wanted.has(identifier)) return true;
        return false;
      })) referencing.add(id);
    }
  }
  for (const side of [base, head]) {
    for (const c of side.result?.dynamicBoundary ?? []) {
      if (c.symbolId && all.has(c.symbolId) && !moved.has(c.symbolId)) dynamicDispatch.add(c.symbolId);
    }
  }
  const sorted = (xs: Iterable<string>) => [...xs].sort();
  return {
    granularity: 'symbol',
    ...(importsAdded ? { importsAdded: true as const } : {}),
    changed: sorted(changed),
    appeared: sorted(appeared),
    disappeared: sorted(disappeared),
    referencing: sorted(referencing),
    dynamicDispatch: sorted([...dynamicDispatch].filter(id => !referencing.has(id))),
  };
}

/**
 * Compute the symbol-level changed-set for the code files a diff names. `baseRef` is resolved the
 * way `getChangedFiles` resolves it, and old content is read at the merge base it diffs from.
 * Never throws: any failure keeps the affected file file-granular.
 */
export async function computeSymbolChangedSet(input: {
  absDir: string;
  baseRef: string;
  diff: readonly DiffEntry[];
  callGraph: SerializedCallGraph;
  /** Overrides {@link MAX_SYMBOL_HASHED_FILES} (tests). */
  maxFiles?: number;
  /** Overrides {@link MAX_SYMBOL_HASHED_BYTES} (tests). */
  maxBytes?: number;
  /** Overrides {@link SYMBOL_HASHING_BUDGET_MS} (tests). */
  budgetMs?: number;
}): Promise<SymbolChangedSet> {
  const maxFiles = input.maxFiles ?? MAX_SYMBOL_HASHED_FILES;
  const byFile = new Map<string, FileSymbolChange>();
  const prefix = await getRepoPrefix(input.absDir);
  if (prefix === null) return { byFile, carried: [] };

  const indexByFile = new Map<string, FunctionNode[]>();
  for (const n of input.callGraph.nodes) {
    if (n.isExternal || n.isTest) continue;
    (indexByFile.get(n.filePath) ?? indexByFile.set(n.filePath, []).get(n.filePath)!).push(n);
  }

  // Every changed file in a call-graph language, whether or not the index holds a symbol for it:
  // a file of constants seeds nothing, but a change in it must still stop the callers of this
  // changed-set from reporting "the code edits are formatting or comments only". Sorted for a
  // stable cap.
  // A path git printed C-quoted (control characters, a quote, a backslash) does not resolve to an
  // indexed file, and dropping it would let a consumer report a diff as unchanged over a file
  // nobody looked at. Disclose it instead, under a rendering-safe name.
  for (const entry of input.diff) {
    if (/^"|[\u0000-\u001f\u007f-\u009f]/.test(entry.path)) {
      byFile.set(entry.path.replace(/[\u0000-\u001f\u007f-\u009f]/g, '?'), { granularity: 'file', reason: 'not-assessed' });
    }
  }
  const work = input.diff
    .filter(entry => !/^"|[\u0000-\u001f\u007f-\u009f]/.test(entry.path))
    .map(entry => ({ entry, local: reframeRepoPath(entry.path, prefix) }))
    .filter((w): w is { entry: DiffEntry; local: string } =>
      w.local !== null
      && (indexByFile.has(w.local) || languageSupport(detectLanguage(w.local)).capabilities.includes('callGraph')))
    .sort((a, b) => (a.local < b.local ? -1 : a.local > b.local ? 1 : 0));
  if (work.length === 0) return { byFile, carried: [] };

  let commit: string;
  try {
    commit = await diffBaseCommit(input.absDir, await resolveBaseRef(input.absDir, input.baseRef));
  } catch {
    for (const w of work) byFile.set(w.local, { granularity: 'file', reason: 'unreadable' });
    return { byFile, carried: [] };
  }

  // Phase 1 — SIZE first, bytes second. Reading every revision of every file and only then
  // applying the budget would retain `files × 2 × SOURCE_SCAN_MAX_FILE_BYTES`, which is an OOM, not
  // a bound. Base sizes come from ONE `git cat-file --batch-check`; head sizes from a stat. The
  // budget is then spent in path order, so which files are hashed is a function of the two
  // revisions, never of timing.
  interface Planned { entry: DiffEntry; local: string; basePath: string; baseKey?: string; wantHead: boolean }
  const planned: Planned[] = [];
  for (const [i, { entry, local }] of work.entries()) {
    if (i >= maxFiles) { byFile.set(local, { granularity: 'file', reason: 'file-cap' }); continue; }
    const renamed = entry.status === 'renamed' && !!entry.oldPath && entry.oldPath !== entry.path;
    const oldRepoPath = renamed ? entry.oldPath! : entry.path;
    // A moved file's symbols carry NEW ids: every importer must be updated, and the index has never
    // seen them. Extract the base side under the path its ids were minted at, so the move reads as
    // disappeared + appeared (every symbol seeded, continuity reporting the carry) rather than as
    // an identical hash set — which would silently drop every symbol in the file.
    const basePath = renamed ? (reframeRepoPath(oldRepoPath, prefix) ?? oldRepoPath) : local;
    planned.push({
      entry, local, basePath,
      ...(entry.status === 'added' ? {} : { baseKey: `${commit}:${oldRepoPath}` }),
      wantHead: entry.status !== 'deleted',
    });
  }
  const baseSizes = await batchBlobSizes(input.absDir, planned.flatMap(p => p.baseKey ? [p.baseKey] : []));
  const headSizes = new Map<string, number>();
  await Promise.all(planned.filter(p => p.wantHead).map(async p => {
    try {
      const st = await lstat(safeJoin(input.absDir, p.local));
      if (st.isFile()) headSizes.set(p.local, st.size);
    } catch { /* missing or unreadable: the read below reports it */ }
  }));

  interface Loaded { entry: DiffEntry; local: string; basePath: string; baseContent?: string; headContent?: string; failed?: boolean }
  const selected: Planned[] = [];
  let budget = input.maxBytes ?? MAX_SYMBOL_HASHED_BYTES;
  for (const p of planned) {
    const baseBytes = p.baseKey ? baseSizes.get(p.baseKey) : 0;
    const headBytes = p.wantHead ? headSizes.get(p.local) : 0;
    // An unknown size is a missing blob or a non-regular working-tree entry; the read reports it.
    const bytes = (baseBytes ?? 0) + (headBytes ?? 0);
    if ((baseBytes ?? 0) > MAX_SYMBOL_HASHED_FILE_BYTES || (headBytes ?? 0) > MAX_SYMBOL_HASHED_FILE_BYTES || bytes > budget) {
      byFile.set(p.local, { granularity: 'file', reason: 'size-cap' });
      continue;
    }
    budget -= bytes;
    selected.push(p);
  }

  const loaded: Loaded[] = [];
  const queue = [...selected];
  const readOne = async (p: Planned): Promise<Loaded> => {
    const [baseContent, headContent] = await Promise.all([
      p.baseKey === undefined ? undefined : readBase(input.absDir, p.baseKey),
      p.wantHead ? readHead(input.absDir, p.local) : undefined,
    ]);
    const failed = (p.baseKey !== undefined && baseContent === undefined)
      || (p.wantHead && headContent === undefined);
    return { entry: p.entry, local: p.local, basePath: p.basePath, baseContent, headContent, failed };
  };
  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      loaded.push(await readOne(next));
    }
  });
  await Promise.all(workers);
  loaded.sort((a, b) => (a.local < b.local ? -1 : a.local > b.local ? 1 : 0));

  // Phase 2 — extract and compare, in path order, until the byte budget is spent.
  const sides = new Map<string, { base: Side; head: Side }>();
  /** Every hashed head side: the clone census the continuity uniqueness guard needs. */
  const headSides: Side[] = [];
  const deadline = Date.now() + (input.budgetMs ?? SYMBOL_HASHING_BUDGET_MS);
  for (const item of loaded) {
    const { entry, local, basePath } = item;
    if (Date.now() >= deadline) { byFile.set(local, { granularity: 'file', reason: 'time-cap' }); continue; }
    if (item.failed) { byFile.set(local, { granularity: 'file', reason: 'unreadable' }); continue; }
    const language = detectLanguage(local);
    const load = async (content: string | undefined, path: string): Promise<Side> => {
      if (content === undefined) return { present: false, content: '' };
      let result: FileExtractResult | undefined;
      try {
        result = await extractFileWithContentHashes({ path, content, language });
      } catch {
        result = undefined;
      }
      return { present: true, content, result };
    };
    const base = await load(item.baseContent, basePath);
    const head = await load(item.headContent, local);
    const change = compareFile(base, head, (indexByFile.get(local) ?? []).map(n => n.id));
    byFile.set(local, change);
    if (head.present) headSides.push(head);
    // Only a file that lost or gained a symbol can take part in a continuity pair (a move crosses
    // two files); retaining the rest would hold every changed file's contents and extract result
    // for nothing.
    if (change.granularity === 'symbol' && (change.disappeared.length > 0 || change.appeared.length > 0)) {
      sides.set(local, { base, head });
    }
  }

  return { baseRef: input.baseRef, byFile, carried: carriedSymbols(byFile, sides, headSides) };
}

/** One node per id: the last one, as the index keeps it (`allNodes.set` is last-write-wins). */
function lastPerId(nodes: readonly FunctionNode[]): FunctionNode[] {
  return [...new Map(nodes.map(n => [n.id, n])).values()];
}

/** Continuity over the symbol-granular files: which disappeared symbols reappeared elsewhere. */
function carriedSymbols(
  byFile: Map<string, FileSymbolChange>,
  sides: Map<string, { base: Side; head: Side }>,
  /** Every hashed head side, including the file-granular ones: a clone there still defeats a match. */
  headSides: readonly Side[],
): CarriedSymbol[] {
  // Nothing disappeared means nothing can be carried — skip the name-normalized body hashing of
  // every appeared symbol, which is the common case on an ordinary diff.
  const anyGone = [...sides.keys()].some(file => {
    const change = byFile.get(file);
    return change?.granularity === 'symbol' && change.disappeared.length > 0;
  });
  if (!anyGone) return [];

  const disappeared: DisappearedSymbol[] = [];
  const appeared: AppearedSymbol[] = [];
  const newNormBodyCount = new Map<string, number>();
  // The census counts EVERY symbol the head revision of every hashed file has, not just the
  // candidates: continuity refuses a match whose body also occurs elsewhere, and a clone in a
  // file-granular changed file would otherwise be invisible and the refusal would not fire.
  for (const side of headSides) {
    for (const n of lastPerId(side.result?.nodes ?? [])) {
      const norm = normalizedBodyHash(side.content.slice(n.startIndex, n.endIndex), n.name);
      newNormBodyCount.set(norm, (newNormBodyCount.get(norm) ?? 0) + 1);
    }
  }
  for (const [file, { base, head }] of sides) {
    const change = byFile.get(file) as SymbolGranularChange;
    const gone = new Set(change.disappeared);
    const fresh = new Set(change.appeared);
    for (const n of lastPerId(base.result?.nodes ?? [])) {
      if (!gone.has(n.id)) continue;
      disappeared.push({ nodeId: n.id, name: n.name, filePath: file, contentHash: hashSpan(base.content.slice(n.startIndex, n.endIndex)) });
    }
    for (const n of lastPerId(head.result?.nodes ?? [])) {
      if (!fresh.has(n.id)) continue;
      const spanText = head.content.slice(n.startIndex, n.endIndex);
      appeared.push({ id: n.id, name: n.name, filePath: file, contentHash: hashSpan(spanText), spanText, normBodyHash: normalizedBodyHash(spanText, n.name) });
    }
  }
  if (disappeared.length === 0 || appeared.length === 0) return [];
  return computeContinuity(disappeared, appeared, newNormBodyCount).pairs
    .map(p => ({ from: p.from.nodeId, to: p.to.id, reason: p.reason, basis: p.basis }));
}

/**
 * Narrow file-level seeds to the symbols the changed-set implicates. A seed in a file the set did
 * not cover, or covered at file granularity, is kept: narrowing only ever removes a seed on evidence.
 */
export function narrowSeedsToChangedSymbols(seeds: FunctionNode[], set: SymbolChangedSet): FunctionNode[] {
  const keep = new Map<string, Set<string>>();
  for (const [file, change] of set.byFile) {
    if (change.granularity !== 'symbol') continue;
    keep.set(file, new Set([...change.changed, ...change.appeared, ...change.disappeared,
      ...change.referencing, ...change.dynamicDispatch]));
  }
  return seeds.filter(seed => keep.get(seed.filePath)?.has(seed.id) ?? true);
}

/**
 * Record every seed file the changed-set did not cover as file-granular `not-assessed`, so the
 * receipt accounts for each file that contributed seeds. Returns a new set; the input is unchanged.
 */
export function coverSeedFiles(set: SymbolChangedSet, seeds: readonly FunctionNode[]): SymbolChangedSet {
  const byFile = new Map(set.byFile);
  for (const seed of seeds) {
    if (!byFile.has(seed.filePath)) byFile.set(seed.filePath, { granularity: 'file', reason: 'not-assessed' });
  }
  return { byFile, carried: set.carried };
}

/**
 * Seeds that did NOT change: they are in the set because they name a changed symbol or hold a
 * dynamic-dispatch site. Callers that publish the seed list as "changed" must disclose this count.
 */
export function seededNotChanged(set: SymbolChangedSet, seeds: readonly FunctionNode[]): number {
  let n = 0;
  for (const seed of seeds) {
    const change = set.byFile.get(seed.filePath);
    if (!change || change.granularity === 'file') continue;
    if (change.referencing.includes(seed.id) || change.dynamicDispatch.includes(seed.id)) n++;
  }
  return n;
}

/** The ids that genuinely changed in a symbol-granular file (for a "what changed" briefing). */
export function changedSymbolIds(change: SymbolGranularChange): Set<string> {
  return new Set([...change.changed, ...change.appeared, ...change.disappeared]);
}

/** Bounded, consumer-facing receipt of how precise the changed-set was. */
export interface ChangeGranularityReceipt {
  symbolExactFiles: number;
  fileGranularFiles: number;
  /** Symbol-exact files whose module level gained imports (see {@link SymbolGranularChange.importsAdded}). */
  importsAddedFiles: number;
  /** Symbols the hashes found changed, appeared, or disappeared — whatever the index knows. */
  changedSymbolsFound: number;
  /** Of those, the ones no indexed symbol matches: the index predates the edit. */
  changedSymbolsNotIndexed: number;
  /** How many file-granular files each reason accounts for (all of them, not the sample). */
  reasons: Partial<Record<FileGranularityReason, number>>;
  /** Which files stayed file-granular and why, bounded to {@link GRANULARITY_FALLBACK_SAMPLE}. */
  fallbacks: Array<{ file: string; reason: FileGranularityReason }>;
  fallbacksOmitted?: number;
}

export const GRANULARITY_FALLBACK_SAMPLE = 20;

export function granularityReceipt(
  set: SymbolChangedSet,
  /** Whether an id exists in the index. Absent → nothing is counted as not-indexed. */
  isIndexed?: (id: string) => boolean,
): ChangeGranularityReceipt {
  const fallbacks: ChangeGranularityReceipt['fallbacks'] = [];
  const reasons: ChangeGranularityReceipt['reasons'] = {};
  let symbolExactFiles = 0;
  let importsAddedFiles = 0;
  let changedSymbolsFound = 0;
  let changedSymbolsNotIndexed = 0;
  for (const [file, change] of [...set.byFile].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (change.granularity === 'symbol') {
      symbolExactFiles++;
      if (change.importsAdded) importsAddedFiles++;
      for (const id of changedSymbolIds(change)) {
        changedSymbolsFound++;
        if (isIndexed && !isIndexed(id)) changedSymbolsNotIndexed++;
      }
      continue;
    }
    fallbacks.push({ file, reason: change.reason });
    reasons[change.reason] = (reasons[change.reason] ?? 0) + 1;
  }
  const shown = fallbacks.slice(0, GRANULARITY_FALLBACK_SAMPLE);
  return {
    symbolExactFiles,
    fileGranularFiles: fallbacks.length,
    importsAddedFiles,
    changedSymbolsFound,
    changedSymbolsNotIndexed,
    reasons,
    fallbacks: shown,
    ...(fallbacks.length > shown.length ? { fallbacksOmitted: fallbacks.length - shown.length } : {}),
  };
}

/**
 * The claim a consumer may make when nothing was seeded, or `undefined` when it may make none.
 * "Nothing differs" is only ever true when every changed code file was hashed AND the hashes found
 * no changed symbol. A symbol that changed but is absent from the index is "not indexed", never
 * "unchanged" — that is the stale-index case, and it is the most common one.
 */
export function noChangeClaim(receipt: ChangeGranularityReceipt): { kind: 'unchanged' | 'not-indexed' | 'not-assessed'; text: string } {
  if (receipt.changedSymbolsFound > 0) {
    return {
      kind: 'not-indexed',
      text: `${receipt.changedSymbolsFound} symbol(s) differ from the base, but none of them is in the index — the index predates these edits, so nothing could be seeded. Re-run analyze_codebase. This is "not indexed", NOT "unchanged".`,
    };
  }
  if (receipt.fileGranularFiles > 0 && receipt.symbolExactFiles === 0) {
    return {
      kind: 'not-assessed',
      text: `No changed code file could be assessed at symbol level (${receipt.fileGranularFiles} file(s), see changeGranularity.fallbacks) — "not assessed", NOT "unchanged".`,
    };
  }
  return {
    kind: 'unchanged',
    text: 'In every changed code file that was hashed, the symbols are unchanged — the edits are formatting or comments only, or were reverted in the working tree before this call.'
      + (receipt.fileGranularFiles > 0
        ? ` ${receipt.fileGranularFiles} other changed file(s) were not assessed at symbol level — "not assessed", not "unchanged".`
        : ''),
  };
}

/** One caveat line for a consumer, or undefined when every changed file was symbol-exact. */
export function importsAddedCaveat(receipt: ChangeGranularityReceipt): string | undefined {
  if (receipt.importsAddedFiles === 0) return undefined;
  return `In ${receipt.importsAddedFiles} changed file(s) the only module-level change was imports that bind new names; ` +
    'the file\'s unchanged symbols were seeded only if they name one. The imported module\'s own load-time side effects are not attributed to them.';
}

export function granularityCaveat(receipt: ChangeGranularityReceipt): string | undefined {
  if (receipt.fileGranularFiles === 0) return undefined;
  const reasons = (Object.keys(receipt.reasons) as FileGranularityReason[]).sort()
    .map(r => `${r} (${receipt.reasons[r]}): ${FILE_GRANULARITY_REASONS[r]}`);
  return `${receipt.fileGranularFiles} changed file(s) stayed at FILE granularity: every production symbol in them counts as changed ` +
    `(see changeGranularity.fallbacks). Reasons: ${reasons.join('; ')}.`;
}
