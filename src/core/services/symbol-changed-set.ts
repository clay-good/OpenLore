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
import { detectLanguage } from '../analyzer/language-detection.js';
import { languageSupport } from '../analyzer/language-support.js';
import { escapeRegExp } from '../../utils/misc.js';
import {
  computeContinuity,
  normalizedBodyHash,
  type AppearedSymbol,
  type ContinuityPair,
  type DisappearedSymbol,
} from '../analyzer/continuity.js';
import { hashSpan } from '../decisions/anchor.js';
import { getRepoPrefix, reframeRepoPath, resolveBaseRef } from '../drift/git-diff.js';
import { execFileGit } from '../../utils/git-exec.js';
import { readFileConfined } from '../../utils/path-confinement.js';
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
export const MAX_SYMBOL_HASHED_BYTES = 2 * 1024 * 1024;

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
  'size-cap': `the diff's code files exceed the ${Math.round(MAX_SYMBOL_HASHED_BYTES / 1024)} KB hashing budget; the rest are not hashed`,
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

async function readBase(absDir: string, commit: string, repoPath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileGit('git', ['cat-file', 'blob', `${commit}:${repoPath}`], {
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

/** Every id's hashes on one side, in document order, joined — a twin id changes if either twin does. */
function hashesById(result: FileExtractResult): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of result.contentHashes!.symbols) out.set(s.id, out.has(s.id) ? `${out.get(s.id)}+${s.hash}` : s.hash);
  return out;
}

/**
 * The file's shape projected onto the symbols both revisions have: residual runs (`T:<count>`) and
 * the shared symbols' runs, with runs that adjoin after a dropped symbol summed. Equal projections
 * mean no module-level code moved across a symbol; an added or removed symbol never changes it.
 */
function projectLayout(layout: readonly string[], shared: ReadonlySet<string>): string {
  const out: string[] = [];
  for (const entry of layout) {
    if (entry.startsWith('S:')) {
      if (!shared.has(entry.slice(2))) continue;   // a symbol only one revision has
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

/** Whole-identifier matcher for one name, compiled once and reused across every span. */
function wordMatcher(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_$])${escapeRegExp(name)}(?![\\p{L}\\p{N}_$])`, 'u');
}

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

  const baseHashes = base.present ? hashesById(base.result!) : new Map<string, string>();
  const headHashes = head.present ? hashesById(head.result!) : new Map<string, string>();
  if (base.present && head.present) {
    if (base.result!.contentHashes!.residual !== head.result!.contentHashes!.residual) {
      return { granularity: 'file', reason: 'module-level-change' };
    }
    const shared = new Set([...baseHashes.keys()].filter(id => headHashes.has(id)));
    if (projectLayout(base.result!.contentHashes!.layout, shared) !== projectLayout(head.result!.contentHashes!.layout, shared)) {
      return { granularity: 'file', reason: 'module-level-change' };
    }
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
  const matchers = [...names].filter(n => n.length > 0).map(wordMatcher);
  if (base.present && head.present && matchers.length > 0) {
    const moduleText = `${residualText(base)}\n${residualText(head)}`;
    if (matchers.some(m => m.test(moduleText))) {
      return { granularity: 'file', reason: 'module-level-reference' };
    }
  }
  const referencing = new Set<string>();
  const dynamicDispatch = new Set<string>();
  const all = new Set([...baseHashes.keys(), ...headHashes.keys()]);
  const textsById = [spanTextsById(base), spanTextsById(head)];
  for (const id of all) {
    if (moved.has(id)) continue;
    const texts = textsById.flatMap(index => index.get(id) ?? []);
    if (matchers.some(m => texts.some(text => m.test(text)))) referencing.add(id);
  }
  for (const side of [base, head]) {
    for (const c of side.result?.dynamicBoundary ?? []) {
      if (c.symbolId && all.has(c.symbolId) && !moved.has(c.symbolId)) dynamicDispatch.add(c.symbolId);
    }
  }
  const sorted = (xs: Iterable<string>) => [...xs].sort();
  return {
    granularity: 'symbol',
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
  const work = input.diff
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

  // Phase 1 — read both revisions of each file, base blobs a few at a time (one `git cat-file`
  // spawn each, ~20 ms serially). The byte budget bounds what is held in memory at once.
  interface Loaded { entry: DiffEntry; local: string; basePath: string; baseContent?: string; headContent?: string; failed?: boolean }
  const loaded: Loaded[] = [];
  let budget = input.maxBytes ?? MAX_SYMBOL_HASHED_BYTES;
  const queue = [...work.entries()];
  const readOne = async ([i, { entry, local }]: [number, { entry: DiffEntry; local: string }]): Promise<Loaded | undefined> => {
    if (i >= maxFiles) { byFile.set(local, { granularity: 'file', reason: 'file-cap' }); return undefined; }
    const renamed = entry.status === 'renamed' && !!entry.oldPath && entry.oldPath !== entry.path;
    const oldRepoPath = renamed ? entry.oldPath! : entry.path;
    // A moved file's symbols carry NEW ids: every importer must be updated, and the index has never
    // seen them. Extract the base side under the path its ids were minted at, so the move reads as
    // disappeared + appeared (every symbol seeded, continuity reporting the carry) rather than as
    // an identical hash set — which would silently drop every symbol in the file.
    const basePath = renamed ? (reframeRepoPath(oldRepoPath, prefix) ?? oldRepoPath) : local;
    const [baseContent, headContent] = await Promise.all([
      entry.status === 'added' ? undefined : readBase(input.absDir, commit, oldRepoPath),
      entry.status === 'deleted' ? undefined : readHead(input.absDir, local),
    ]);
    const failed = (entry.status !== 'added' && baseContent === undefined)
      || (entry.status !== 'deleted' && headContent === undefined);
    return { entry, local, basePath, baseContent, headContent, failed };
  };
  const workers = Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) return;
      const item = await readOne(next);
      if (item) loaded.push(item);
    }
  });
  await Promise.all(workers);
  loaded.sort((a, b) => (a.local < b.local ? -1 : a.local > b.local ? 1 : 0));

  // Phase 2 — extract and compare, in path order, until the byte budget is spent.
  const sides = new Map<string, { base: Side; head: Side }>();
  for (const item of loaded) {
    const { entry, local, basePath } = item;
    if (item.failed) { byFile.set(local, { granularity: 'file', reason: 'unreadable' }); continue; }
    const bytes = (item.baseContent?.length ?? 0) + (item.headContent?.length ?? 0);
    if (bytes > budget) { byFile.set(local, { granularity: 'file', reason: 'size-cap' }); continue; }
    budget -= bytes;
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
    const base = await load(entry.status === 'added' ? undefined : item.baseContent, basePath);
    const head = await load(entry.status === 'deleted' ? undefined : item.headContent, local);
    const change = compareFile(base, head, (indexByFile.get(local) ?? []).map(n => n.id));
    byFile.set(local, change);
    // Only a file that lost or gained a symbol can take part in a continuity pair (a move crosses
    // two files); retaining the rest would hold every changed file's contents and extract result
    // for nothing.
    if (change.granularity === 'symbol' && (change.disappeared.length > 0 || change.appeared.length > 0)) {
      sides.set(local, { base, head });
    }
  }

  return { byFile, carried: carriedSymbols(byFile, sides) };
}

/** One node per id: the last one, as the index keeps it (`allNodes.set` is last-write-wins). */
function lastPerId(nodes: readonly FunctionNode[]): FunctionNode[] {
  return [...new Map(nodes.map(n => [n.id, n])).values()];
}

/** Continuity over the symbol-granular files: which disappeared symbols reappeared elsewhere. */
function carriedSymbols(
  byFile: Map<string, FileSymbolChange>,
  sides: Map<string, { base: Side; head: Side }>,
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
  for (const [file, { base, head }] of sides) {
    const change = byFile.get(file) as SymbolGranularChange;
    const gone = new Set(change.disappeared);
    const fresh = new Set(change.appeared);
    for (const n of lastPerId(base.result?.nodes ?? [])) {
      if (!gone.has(n.id)) continue;
      disappeared.push({ nodeId: n.id, name: n.name, filePath: file, contentHash: hashSpan(base.content.slice(n.startIndex, n.endIndex)) });
    }
    for (const n of lastPerId(head.result?.nodes ?? [])) {
      const spanText = head.content.slice(n.startIndex, n.endIndex);
      const norm = normalizedBodyHash(spanText, n.name);
      newNormBodyCount.set(norm, (newNormBodyCount.get(norm) ?? 0) + 1);
      if (fresh.has(n.id)) appeared.push({ id: n.id, name: n.name, filePath: file, contentHash: hashSpan(spanText), spanText, normBodyHash: norm });
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
  /** How many file-granular files each reason accounts for (all of them, not the sample). */
  reasons: Partial<Record<FileGranularityReason, number>>;
  /** Which files stayed file-granular and why, bounded to {@link GRANULARITY_FALLBACK_SAMPLE}. */
  fallbacks: Array<{ file: string; reason: FileGranularityReason }>;
  fallbacksOmitted?: number;
}

export const GRANULARITY_FALLBACK_SAMPLE = 20;

export function granularityReceipt(set: SymbolChangedSet): ChangeGranularityReceipt {
  const fallbacks: ChangeGranularityReceipt['fallbacks'] = [];
  const reasons: ChangeGranularityReceipt['reasons'] = {};
  let symbolExactFiles = 0;
  for (const [file, change] of [...set.byFile].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (change.granularity === 'symbol') { symbolExactFiles++; continue; }
    fallbacks.push({ file, reason: change.reason });
    reasons[change.reason] = (reasons[change.reason] ?? 0) + 1;
  }
  const shown = fallbacks.slice(0, GRANULARITY_FALLBACK_SAMPLE);
  return {
    symbolExactFiles,
    fileGranularFiles: fallbacks.length,
    reasons,
    fallbacks: shown,
    ...(fallbacks.length > shown.length ? { fallbacksOmitted: fallbacks.length - shown.length } : {}),
  };
}

/** One caveat line for a consumer, or undefined when every changed file was symbol-exact. */
export function granularityCaveat(receipt: ChangeGranularityReceipt): string | undefined {
  if (receipt.fileGranularFiles === 0) return undefined;
  const reasons = (Object.keys(receipt.reasons) as FileGranularityReason[]).sort()
    .map(r => `${r} (${receipt.reasons[r]}): ${FILE_GRANULARITY_REASONS[r]}`);
  return `${receipt.fileGranularFiles} changed file(s) stayed at FILE granularity: every production symbol in them counts as changed ` +
    `(see changeGranularity.fallbacks). Reasons: ${reasons.join('; ')}.`;
}
