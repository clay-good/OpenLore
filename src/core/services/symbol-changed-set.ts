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
import {
  computeContinuity,
  normalizedBodyHash,
  renameIdentifier,
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

/** Per-read git timeout. A slow read falls back to file granularity; it never blocks the tool. */
const GIT_READ_TIMEOUT_MS = 10_000;

/** Why a changed file keeps file-level granularity. A closed vocabulary. */
export type FileGranularityReason =
  | 'language-not-hashed'
  | 'parse-errors'
  | 'module-level-change'
  | 'span-not-contiguous'
  | 'invalid-span'
  | 'unreadable'
  | 'index-mismatch'
  | 'file-cap';

export const FILE_GRANULARITY_REASONS: Record<FileGranularityReason, string> = {
  'language-not-hashed': 'the language has no native parse tree to hash (no extractor, a WASM grammar, or a script container)',
  'parse-errors': 'one side has parse errors, so its tree is not trustworthy evidence',
  'module-level-change': 'code outside every symbol changed (imports, module-level statements, class fields, or symbol order)',
  'span-not-contiguous': 'a symbol span does not map to one contiguous run of the parse tree',
  'invalid-span': 'a symbol span lies outside its file',
  'unreadable': 'one side could not be read (missing blob, over the size bound, or a failed read)',
  'index-mismatch': 'the index lists symbols in this file that neither revision extracts to (re-run analyze)',
  'file-cap': `the diff names more than ${MAX_SYMBOL_HASHED_FILES} code files; the rest are not hashed`,
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

/** The order of the ids both sides share: a pure reorder is a module-level change. */
function sharedOrder(order: string[], shared: Set<string>): string {
  return order.filter(id => shared.has(id)).join('\0');
}

function namesWord(text: string, name: string): boolean {
  return name.length > 0 && renameIdentifier(text, name, '\uFFFF') !== text;
}

function spanTexts(side: Side, id: string): string[] {
  if (!side.result) return [];
  return side.result.nodes.filter(n => n.id === id).map(n => side.content.slice(n.startIndex, n.endIndex));
}

function sideUsable(side: Side): FileGranularityReason | undefined {
  if (!side.present) return undefined;
  const r = side.result;
  if (!r || r.grammarUnavailable || r.grammarUnavailableAll?.length || !r.contentHashes) return 'language-not-hashed';
  if (r.parseHealth) return 'parse-errors';
  if (r.contentHashes.residualUnavailable) return r.contentHashes.residualUnavailable;
  return undefined;
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
    if (sharedOrder(base.result!.contentHashes!.order, shared) !== sharedOrder(head.result!.contentHashes!.order, shared)) {
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
  const referencing = new Set<string>();
  const dynamicDispatch = new Set<string>();
  const all = new Set([...baseHashes.keys(), ...headHashes.keys()]);
  for (const id of all) {
    if (moved.has(id)) continue;
    const texts = [...spanTexts(base, id), ...spanTexts(head, id)];
    if ([...names].some(name => texts.some(text => namesWord(text, name)))) referencing.add(id);
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

  // Only files the index holds production symbols for can seed anything; sorted for a stable cap.
  const work = input.diff
    .map(entry => ({ entry, local: reframeRepoPath(entry.path, prefix) }))
    .filter((w): w is { entry: DiffEntry; local: string } => w.local !== null && indexByFile.has(w.local))
    .sort((a, b) => (a.local < b.local ? -1 : a.local > b.local ? 1 : 0));
  if (work.length === 0) return { byFile, carried: [] };

  let commit: string;
  try {
    commit = await diffBaseCommit(input.absDir, await resolveBaseRef(input.absDir, input.baseRef));
  } catch {
    for (const w of work) byFile.set(w.local, { granularity: 'file', reason: 'unreadable' });
    return { byFile, carried: [] };
  }

  const sides = new Map<string, { base: Side; head: Side }>();
  for (const [i, { entry, local }] of work.entries()) {
    if (i >= maxFiles) {
      byFile.set(local, { granularity: 'file', reason: 'file-cap' });
      continue;
    }
    const language = detectLanguage(local);
    const load = async (present: boolean, read: () => Promise<string | undefined>): Promise<Side | undefined> => {
      if (!present) return { present: false, content: '' };
      const content = await read();
      if (content === undefined) return undefined;
      let result: FileExtractResult | undefined;
      try {
        result = await extractFileWithContentHashes({ path: local, content, language });
      } catch {
        result = undefined;
      }
      return { present: true, content, result };
    };
    const oldRepoPath = entry.status === 'renamed' && entry.oldPath ? entry.oldPath : entry.path;
    const base = await load(entry.status !== 'added', () => readBase(input.absDir, commit, oldRepoPath));
    const head = await load(entry.status !== 'deleted', () => readHead(input.absDir, local));
    if (!base || !head) {
      byFile.set(local, { granularity: 'file', reason: 'unreadable' });
      continue;
    }
    const change = compareFile(base, head, indexByFile.get(local)!.map(n => n.id));
    byFile.set(local, change);
    if (change.granularity === 'symbol') sides.set(local, { base, head });
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
