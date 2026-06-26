/**
 * MCP handler: certify_public_surface (change: add-public-api-surface-contract).
 *
 * Two conclusion modes over a package/module's exported public surface:
 *  - No base ref → return the PUBLIC SURFACE: the exported symbols and their signatures.
 *  - A base ref  → return the BREAKING-CHANGE VERDICT for the current diff: each changed
 *    public symbol classified `breaking | non-breaking | potentially-breaking`, each
 *    breaking one paired with the in-repo consumers it breaks, plus an overall summary.
 *
 * Deterministic, no LLM, no type checker, no build. Conservative by construction: a
 * change that cannot be proven compatible from the available signatures is
 * `potentially-breaking`, never silently `non-breaking`. Renamed exports are reported
 * as renames (not remove+add) via the symbol-identity continuity map (change:
 * add-symbol-identity-continuity). External/unindexed consumers are disclosed as a
 * known-unknowable boundary rather than implied to be absent.
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateDirectory, readCachedContext } from './utils.js';
import { assembleBoundary, computeStaleness } from './confidence-boundary.js';
import { parseJSExports } from '../../analyzer/import-parser.js';
import { detectLanguage } from '../../analyzer/signature-extractor.js';
import { isTestFile } from '../../analyzer/test-file.js';
import { CallGraphBuilder, serializeCallGraph } from '../../analyzer/call-graph.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';
import { hashSpan } from '../../decisions/anchor.js';
import {
  computeContinuity,
  normalizedBodyHash,
  type DisappearedSymbol,
  type AppearedSymbol,
} from '../../analyzer/continuity.js';
import {
  classifySignatureChange,
  signatureClassifiable,
  overallClass,
  type SurfaceChange,
  type SurfaceKind,
  type ChangeClass,
} from '../../analyzer/public-surface.js';

const execFileAsync = promisify(execFile);

const MAX_SURFACE = 500;
const MAX_CONSUMERS = 25;
const SOURCE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/i;

export interface CertifyPublicSurfaceInput {
  directory: string;
  /** Diff the working tree's public surface against this ref. Omit to return the surface itself. */
  baseRef?: string;
  /** Cap the surface listing (surface mode). */
  maxResults?: number;
}

// ── exported-name extraction (the surface predicate, computable on any content) ──

/** A `/` may legally begin a regex literal only after one of these single-char (value-NOT-expected)
 *  tokens, or at line/file start. A `/` after an identifier, number, `)` or `]` is division. */
const REGEX_PRECEDERS = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);

/**
 * Blank out the CONTENT of string/template/regex literals and line/block comments so the export
 * regexes never match an `export …` that appears inside one (common in codegen/fixture source) —
 * a phantom that would otherwise read as an added/removed contract symbol.
 *
 * Single left-to-right state scan, NOT a pipeline of independent regexes: a string can contain
 * `//` (a URL), a comment can contain a quote, and a regex can contain a quote (`/can't/`), so the
 * only correct way to decide "am I in a string vs comment vs regex" is positionally. Hardening
 * history (each was a false-`non-breaking`): the original regex pipeline stripped `//` inside a
 * string; a string with no closing quote (or a regex's stray quote) then blanked to EOF, hiding
 * real declarations below. Fixes: a `'`/`"` string TERMINATES at a raw newline (JS strings can't
 * span one), and a regex literal is recognized only when a regex can legally start AND a closing
 * `/` exists on the same line — so a division operator never blanks a line. Delimiters and newlines
 * are preserved so positions/quote-balance are undisturbed.
 */
function blankLiterals(content: string): string {
  let out = '';
  let i = 0;
  const n = content.length;
  let lastSig = ''; // last significant emitted char(s), for regex-vs-division disambiguation
  const setSig = (s: string): void => { lastSig = s; };
  while (i < n) {
    const c = content[i];
    const c2 = content[i + 1];
    if (c === '/' && c2 === '/') {
      out += '  '; i += 2;
      while (i < n && content[i] !== '\n') { out += ' '; i++; }
    } else if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < n && !(content[i] === '*' && content[i + 1] === '/')) { out += content[i] === '\n' ? '\n' : ' '; i++; }
      if (i < n) { out += '  '; i += 2; }
    } else if (c === '"' || c === "'") {
      out += c; i++;
      while (i < n && content[i] !== c && content[i] !== '\n') {
        if (content[i] === '\\') { out += '  '; i += 2; continue; }
        out += ' '; i++;
      }
      if (i < n && content[i] === c) { out += c; i++; }
      setSig(c);
    } else if (c === '`') {
      out += '`'; i++;
      while (i < n && content[i] !== '`') {
        if (content[i] === '\\') { out += '  '; i += 2; continue; }
        out += content[i] === '\n' ? '\n' : ' '; i++;
      }
      if (i < n) { out += '`'; i++; }
      setSig('`');
    } else if (c === '/' && REGEX_PRECEDERS.has(lastSig) && hasClosingSlashOnLine(content, i + 1, n)) {
      // Regex literal: blank its body (so `/export function x/` is not a phantom export, and a quote
      // inside it does not open a string), then keep its flags.
      out += '/'; i++;
      let inClass = false;
      while (i < n && content[i] !== '\n' && !(content[i] === '/' && !inClass)) {
        if (content[i] === '\\') { out += '  '; i += 2; continue; }
        if (content[i] === '[') inClass = true;
        else if (content[i] === ']') inClass = false;
        out += ' '; i++;
      }
      if (i < n && content[i] === '/') { out += '/'; i++; }
      while (i < n && /[a-z]/i.test(content[i])) { out += content[i]; i++; } // flags
      setSig('/');
    } else {
      out += c; i++;
      if (!/\s/.test(c)) setSig(c);
    }
  }
  return out;
}

/** Is there an unescaped, non-char-class `/` (regex close) before the next newline starting at `from`? */
function hasClosingSlashOnLine(s: string, from: number, n: number): boolean {
  let inClass = false;
  for (let j = from; j < n && s[j] !== '\n'; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === '[') inClass = true;
    else if (s[j] === ']') inClass = false;
    else if (s[j] === '/' && !inClass) return true;
  }
  return false;
}

/** Reserved words that, when returned as an export "name" by parseJSExports, signal a parse glitch
 *  (e.g. `export const enum X` mis-parses to name "enum") and must not be treated as a contract symbol. */
const RESERVED_NAMES = new Set(['enum', 'interface', 'class', 'function', 'const', 'let', 'var', 'type', 'default', 'async', 'abstract', 'declare']);

/** Top-level exported names for a file's content, per language. Fail-soft (empty set) for unsupported. */
function exportedNames(rawContent: string, language: string): Set<string> {
  const content = blankLiterals(rawContent);
  if (language === 'TypeScript' || language === 'JavaScript') {
    // Skip RE-EXPORTS (`export { x } from './a'`): their identity and breaking-ness are governed at
    // the definition site (tracked there), and counting them here double-reports a barrel'd symbol
    // (and turns a definition-site rename into a phantom remove+add at the barrel). Matches the
    // surface-listing path, which also filters re-exports.
    const names = new Set(
      parseJSExports(content)
        .filter((e) => !e.isReExport && e.name && e.name !== 'default' && !RESERVED_NAMES.has(e.name))
        .map((e) => e.name),
    );
    // `parseJSExports`' `export function` regex matches neither `export async function` nor a
    // GENERATOR (`export function* gen` / `export async function* agen`) — recover all of those
    // here so async/generator exports are not silently dropped. Local fix; shared parser unchanged.
    const fn = /\bexport\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g;
    // `parseJSExports` also mis-names `export const enum X` (and `export enum X`) — recover the real
    // enum name (the bare `enum` token was filtered out above as a reserved-word glitch).
    const en = /\bexport\s+(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/g;
    let m: RegExpExecArray | null;
    while ((m = fn.exec(content)) !== null) names.add(m[1]);
    while ((m = en.exec(content)) !== null) names.add(m[1]);
    return names;
  }
  if (language === 'Python') {
    const names = new Set<string>();
    const re = /^(?:async\s+)?(?:def|class)\s+([A-Za-z][A-Za-z0-9_]*)/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) if (!m[1].startsWith('_')) names.add(m[1]);
    return names;
  }
  return new Set();
}

/** A public-surface function with the spans/hashes continuity needs to detect a rename. */
interface SurfaceFn {
  name: string;
  file: string;
  signature: string;
  language: string;
  nodeId: string;
  spanText: string;
  contentHash: string;
  normBodyHash: string;
}

/** Content of a file at a git ref, or '' when it did not exist there. */
async function fileAtRef(rootPath: string, ref: string, path: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['show', `${ref}:${path}`], {
      cwd: rootPath,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return '';
  }
}

/** The merge-base of `base` and HEAD (so old content is read from the branch point), else `base`. */
async function mergeBase(rootPath: string, base: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', ['merge-base', base, 'HEAD'], { cwd: rootPath });
    const sha = stdout.trim();
    return sha.length > 0 ? sha : base;
  } catch {
    return base;
  }
}

/**
 * Build the public-surface function set for an in-memory set of files. The call-graph
 * snapshot supplies signatures + source spans; the export set decides membership. Also
 * returns the name-independent body-hash census over ALL top-level functions in the
 * snapshot (exported or not), which the continuity uniqueness guard needs.
 */
async function buildSurface(
  files: Array<{ path: string; content: string; language: string }>,
): Promise<{ exported: SurfaceFn[]; normBodyCount: Map<string, number>; allFnNames: Map<string, Set<string>> }> {
  const exported: SurfaceFn[] = [];
  const normBodyCount = new Map<string, number>();
  // All top-level function names per file (exported OR not) — lets the diff tell a removed export
  // (the symbol is gone) apart from a visibility reduction (still defined, no longer exported).
  const allFnNames = new Map<string, Set<string>>();
  if (files.length === 0) return { exported, normBodyCount, allFnNames };
  let snap: SerializedCallGraph | null = null;
  try {
    snap = serializeCallGraph(await new CallGraphBuilder().build(files));
  } catch {
    return { exported, normBodyCount, allFnNames };
  }
  const contentByFile = new Map(files.map((f) => [f.path, f.content]));
  const exportsByFile = new Map(files.map((f) => [f.path, exportedNames(f.content, f.language)]));
  for (const node of snap.nodes) {
    if (node.isExternal || node.isTest || node.className) continue; // top-level functions only
    const content = contentByFile.get(node.filePath);
    if (content === undefined) continue;
    const spanText = content.slice(node.startIndex, node.endIndex);
    if (!spanText) continue;
    (allFnNames.get(node.filePath) ?? allFnNames.set(node.filePath, new Set()).get(node.filePath)!).add(node.name);
    const nbh = normalizedBodyHash(spanText, node.name);
    normBodyCount.set(nbh, (normBodyCount.get(nbh) ?? 0) + 1);
    if (!(exportsByFile.get(node.filePath)?.has(node.name))) continue;
    exported.push({
      name: node.name,
      file: node.filePath,
      signature: node.signature ?? '',
      language: node.language,
      nodeId: node.id,
      spanText,
      contentHash: hashSpan(spanText),
      normBodyHash: nbh,
    });
  }
  return { exported, normBodyCount, allFnNames };
}

function kindFromSignature(sig: string): SurfaceKind {
  const s = sig.trimStart();
  if (/^(export\s+)?(default\s+)?(abstract\s+)?class\b/.test(s)) return 'class';
  if (/\binterface\b/.test(s)) return 'interface';
  if (/^(export\s+)?type\b/.test(s)) return 'type';
  if (/^(export\s+)?(default\s+)?(async\s+)?function\b/.test(s) || /=>\s*$/.test(s) || /\(/.test(s)) return 'function';
  return 'function';
}

// ── consumer resolution ─────────────────────────────────────────────────────

interface Consumer {
  id: string;
  name: string;
  file: string;
}

function callerToConsumer(callerId: string): Consumer {
  const idx = callerId.lastIndexOf('::');
  if (idx < 0) return { id: callerId, name: callerId, file: '' };
  return { id: callerId, name: callerId.slice(idx + 2), file: callerId.slice(0, idx) };
}

interface EdgeStoreLike {
  getCallers(nodeId: string): Array<{ callerId: string; calleeName?: string }>;
}

/**
 * In-repo callers of one or more node ids, deduped + bounded; null edgeStore → empty (disclosed
 * upstream). Multiple ids are unioned so a RENAME can be looked up under BOTH the old id (the
 * index was built at the base, where the old name still resolves) AND the new id (the index was
 * built at HEAD) — either way the consumers that bind the symbol are surfaced.
 */
function resolveConsumers(edgeStore: EdgeStoreLike | undefined, nodeIds: string[]): { consumers: Consumer[]; truncated: number } {
  if (!edgeStore) return { consumers: [], truncated: 0 };
  const seen = new Set<string>();
  const all: Consumer[] = [];
  for (const nodeId of nodeIds) {
    for (const e of edgeStore.getCallers(nodeId)) {
      if (seen.has(e.callerId)) continue;
      seen.add(e.callerId);
      all.push(callerToConsumer(e.callerId));
    }
  }
  all.sort((a, b) => a.id.localeCompare(b.id));
  return { consumers: all.slice(0, MAX_CONSUMERS), truncated: Math.max(0, all.length - MAX_CONSUMERS) };
}

// ── the two modes ───────────────────────────────────────────────────────────

interface SurfaceListResult {
  mode: 'surface';
  surface: Array<{ name: string; file: string; kind: SurfaceKind; signature?: string }>;
  total: number;
  truncated: { omitted: number } | null;
  confidenceBoundary: ReturnType<typeof assembleBoundary>;
}

async function listSurface(absDir: string, ctx: Awaited<ReturnType<typeof readCachedContext>>, maxResults: number): Promise<SurfaceListResult> {
  const symbols: Array<{ name: string; file: string; kind: SurfaceKind; signature?: string }> = [];
  // Signatures of current top-level functions, keyed by `${file}::${name}`.
  const sigByKey = new Map<string, string>();
  for (const n of ctx?.callGraph?.nodes ?? []) {
    if (!n.className && !n.isExternal && n.signature) sigByKey.set(`${n.filePath}::${n.name}`, n.signature);
  }
  // Exports from the persisted dependency graph.
  try {
    const raw = await readFile(join(absDir, '.openlore/analysis/dependency-graph.json'), 'utf-8');
    const dg = JSON.parse(raw) as { nodes?: Array<{ file?: { path?: string }; exports?: Array<{ name: string; kind?: string; isReExport?: boolean }> }> };
    for (const node of dg.nodes ?? []) {
      const file = node.file?.path;
      if (!file || !SOURCE_RE.test(file) || isTestFile(file)) continue;
      for (const exp of node.exports ?? []) {
        if (!exp.name || exp.name === 'default' || exp.isReExport) continue;
        const sig = sigByKey.get(`${file}::${exp.name}`);
        symbols.push({
          name: exp.name,
          file,
          kind: (exp.kind as SurfaceKind) ?? 'unknown',
          ...(sig ? { signature: sig } : {}),
        });
      }
    }
  } catch {
    /* no dependency graph — empty surface */
  }
  symbols.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  const total = symbols.length;
  const cap = Math.max(1, Math.min(maxResults, MAX_SURFACE));
  const shown = symbols.slice(0, cap);
  return {
    mode: 'surface',
    surface: shown,
    total,
    truncated: total > shown.length ? { omitted: total - shown.length } : null,
    confidenceBoundary: assembleBoundary({ staleness: await computeStaleness(absDir), integrity: ctx?.integrity }),
  };
}

async function changedSourceFiles(absDir: string, base: string): Promise<Array<{ path: string; oldPath?: string; status: string }>> {
  const { getChangedFiles } = await import('../../drift/git-diff.js');
  const diff = await getChangedFiles({ rootPath: absDir, baseRef: base, includeUnstaged: true });
  // A test file is not part of the public API surface — exclude it (it also tends to embed
  // `export …` strings in fixtures that would otherwise read as phantom contract symbols).
  const eligible = (p: string): boolean => SOURCE_RE.test(p) && !isTestFile(p);
  const out = diff.files
    .filter((f) => eligible(f.path))
    .map((f) => ({ path: f.path, status: f.status as string, ...(f.oldPath ? { oldPath: f.oldPath } : {}) }));
  const seen = new Set(out.map((c) => c.path));
  try {
    const { stdout } = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: absDir, maxBuffer: 16 * 1024 * 1024 });
    for (const path of stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (eligible(path) && !seen.has(path)) { seen.add(path); out.push({ path, status: 'added' }); }
    }
  } catch { /* best-effort */ }
  return out;
}

async function diffSurface(
  absDir: string,
  ctx: Awaited<ReturnType<typeof readCachedContext>>,
  baseRef: string,
): Promise<unknown> {
  const { resolveBaseRef, validateGitRef } = await import('../../drift/git-diff.js');
  try { validateGitRef(baseRef); } catch (e) { return { error: (e as Error).message }; }
  let resolvedBase: string;
  try { resolvedBase = await resolveBaseRef(absDir, baseRef); } catch (e) { return { error: `cannot resolve base ref: ${(e as Error).message}` }; }
  const oldRef = await mergeBase(absDir, resolvedBase);

  const changed = await changedSourceFiles(absDir, resolvedBase);
  // Read base + head content for every changed file.
  const baseFiles: Array<{ path: string; content: string; language: string }> = [];
  const headFiles: Array<{ path: string; content: string; language: string }> = [];
  for (const f of changed) {
    const headContent = f.status === 'deleted' ? '' : await readFile(resolve(absDir, f.path), 'utf-8').catch(() => '');
    const baseContent = await fileAtRef(absDir, oldRef, f.oldPath ?? f.path);
    if (headContent) headFiles.push({ path: f.path, content: headContent, language: detectLanguage(f.path) });
    if (baseContent) baseFiles.push({ path: f.oldPath ?? f.path, content: baseContent, language: detectLanguage(f.oldPath ?? f.path) });
  }

  // Reconcile a renamed file: map base path → head path so (file,name) pairs line up.
  const headPathOf = new Map<string, string>();
  for (const f of changed) if (f.oldPath) headPathOf.set(f.oldPath, f.path);

  const { extraCrossings, ...diff } = await assembleSurfaceDiff(baseFiles, headFiles, headPathOf, ctx?.edgeStore as EdgeStoreLike | undefined);
  return {
    mode: 'diff',
    base: resolvedBase,
    head: 'working tree',
    ...diff,
    confidenceBoundary: assembleBoundary({ staleness: await computeStaleness(absDir), integrity: ctx?.integrity, extraCrossings }),
  };
}

/**
 * The pure breaking-change core: classify the public-surface delta between two sets of
 * file contents. No git, no readCachedContext, no clock — git I/O and the
 * confidence-boundary live in `diffSurface`. Exposed so the classification can be
 * unit-tested in CI from in-memory contents with a stub edge store. Deterministic.
 */
export async function assembleSurfaceDiff(
  baseFiles: Array<{ path: string; content: string; language: string }>,
  headFiles: Array<{ path: string; content: string; language: string }>,
  headPathOf: Map<string, string>,
  edgeStore?: EdgeStoreLike,
): Promise<{
  overall: ChangeClass;
  summary: { breaking: number; potentiallyBreaking: number; nonBreaking: number };
  changes: SurfaceChange[];
  breaking: Array<SurfaceChange & { consumers: Consumer[]; consumersTruncated: number }>;
  soundness: { posture: string; languages: string };
  extraCrossings: Array<{ kind: 'unindexed-repo'; count: number; detail: string }>;
}> {
  const baseSurface = await buildSurface(baseFiles);
  const headSurface = await buildSurface(headFiles);

  const keyHead = (f: SurfaceFn): string => `${f.file}::${f.name}`;
  const keyBase = (f: SurfaceFn): string => `${headPathOf.get(f.file) ?? f.file}::${f.name}`;

  const headByKey = new Map(headSurface.exported.map((f) => [keyHead(f), f]));
  const baseByKey = new Map(baseSurface.exported.map((f) => [keyBase(f), f]));

  const changes: SurfaceChange[] = [];
  const removedFns: SurfaceFn[] = [];
  const addedFns: SurfaceFn[] = [];

  // Symbols present on both sides → signature classification.
  for (const [key, head] of headByKey) {
    const base = baseByKey.get(key);
    if (!base) { addedFns.push(head); continue; }
    const { class: cls, reasons } = classifySignatureChange(base.signature, head.signature, head.language);
    if (cls === 'non-breaking' && reasons.length === 0) continue; // unchanged contract
    changes.push({
      changeKind: 'signature',
      class: cls,
      name: head.name,
      file: head.file,
      kind: kindFromSignature(head.signature),
      before: base.signature,
      after: head.signature,
      reasons,
    });
  }
  // Symbols only in base → removed (candidate rename source).
  for (const [key, base] of baseByKey) if (!headByKey.has(key)) removedFns.push(base);

  // Rename detection via the symbol-identity continuity map (renamed export ≠ remove+add).
  const disappeared: DisappearedSymbol[] = removedFns.map((f) => ({ nodeId: f.nodeId, name: f.name, filePath: f.file, contentHash: f.contentHash }));
  const appeared: AppearedSymbol[] = addedFns.map((f) => ({ id: f.nodeId, name: f.name, filePath: f.file, contentHash: f.contentHash, spanText: f.spanText, normBodyHash: f.normBodyHash }));
  const newNormBodyCount = headSurface.normBodyCount;
  const continuity = computeContinuity(disappeared, appeared, newNormBodyCount);
  const renamedFrom = new Set<string>();
  const renamedTo = new Set<string>();
  for (const pair of continuity.pairs) {
    renamedFrom.add(pair.from.nodeId);
    renamedTo.add(pair.to.id);
    const base = removedFns.find((f) => f.nodeId === pair.from.nodeId)!;
    changes.push({
      changeKind: 'renamed',
      class: 'breaking', // consumers binding the old name break, but it IS a rename, not a remove
      name: base.name,
      file: base.file,
      kind: kindFromSignature(base.signature),
      before: base.signature,
      after: pair.to.id.slice(pair.to.id.lastIndexOf('::') + 2),
      reasons: [`exported symbol renamed to "${pair.to.name}" (${pair.reason}, basis: ${pair.basis})`],
      rename: { to: pair.to.name, file: pair.to.filePath, reason: pair.reason, basis: pair.basis },
    });
  }

  // Genuine removals (not a confident rename) → breaking. A symbol that is STILL defined in the
  // head file but no longer exported is a VISIBILITY REDUCTION (public → private), not a removal —
  // both break consumers, but the distinction is reported honestly.
  for (const base of removedFns) {
    if (renamedFrom.has(base.nodeId)) continue;
    const headPath = headPathOf.get(base.file) ?? base.file;
    const stillDefined = headSurface.allFnNames.get(headPath)?.has(base.name) ?? false;
    changes.push({
      changeKind: stillDefined ? 'visibility-reduced' : 'removed',
      class: 'breaking',
      name: base.name,
      file: headPath,
      kind: kindFromSignature(base.signature),
      before: base.signature,
      reasons: [stillDefined
        ? 'exported symbol is still defined but no longer exported (visibility reduced: public → private)'
        : 'exported symbol was removed from the public surface'],
    });
  }

  // New exports (not a rename target) → non-breaking.
  for (const head of addedFns) {
    if (renamedTo.has(head.nodeId)) continue;
    changes.push({
      changeKind: 'added',
      class: 'non-breaking',
      name: head.name,
      file: head.file,
      kind: kindFromSignature(head.signature),
      after: head.signature,
      reasons: ['new export added to the public surface'],
    });
  }

  // Name-level export pass: catch removed/added EXPORTS that resolve to no function node —
  // aliased re-exports (`export { impl as publicName }`), generators, and const/class/type
  // exports. Without this, removing such an export reads as "no change" (a false-safe, the
  // dangerous direction). Function-backed symbols are already handled above and are excluded
  // here so nothing is double-counted; their internal contract change is classified above.
  const handledKeys = new Set<string>();
  for (const f of headSurface.exported) handledKeys.add(`${f.file}::${f.name}`);
  for (const f of baseSurface.exported) handledKeys.add(`${headPathOf.get(f.file) ?? f.file}::${f.name}`);
  for (const pair of continuity.pairs) {
    handledKeys.add(`${headPathOf.get(pair.from.filePath) ?? pair.from.filePath}::${pair.from.name}`);
    handledKeys.add(`${pair.to.filePath}::${pair.to.name}`);
  }
  // Exported name sets, both keyed by the HEAD-side path (so a renamed file lines up).
  const baseNamesByPath = new Map<string, Set<string>>();
  for (const bf of baseFiles) {
    const hp = headPathOf.get(bf.path) ?? bf.path;
    const set = baseNamesByPath.get(hp) ?? new Set<string>();
    for (const n of exportedNames(bf.content, bf.language)) set.add(n);
    baseNamesByPath.set(hp, set);
  }
  const headNamesByPath = new Map<string, Set<string>>();
  for (const hf of headFiles) headNamesByPath.set(hf.path, exportedNames(hf.content, hf.language));
  for (const path of new Set([...baseNamesByPath.keys(), ...headNamesByPath.keys()])) {
    const baseN = baseNamesByPath.get(path) ?? new Set<string>();
    const headN = headNamesByPath.get(path) ?? new Set<string>();
    for (const name of baseN) {
      if (headN.has(name) || handledKeys.has(`${path}::${name}`)) continue;
      changes.push({
        changeKind: 'removed',
        class: 'breaking',
        name,
        file: path,
        kind: 'unknown',
        reasons: ['exported symbol was removed from the public surface (no signature available — non-function or aliased export)'],
      });
    }
    for (const name of headN) {
      if (baseN.has(name) || handledKeys.has(`${path}::${name}`)) continue;
      changes.push({
        changeKind: 'added',
        class: 'non-breaking',
        name,
        file: path,
        kind: 'unknown',
        reasons: ['new export added to the public surface'],
      });
    }
  }

  changes.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name) || a.changeKind.localeCompare(b.changeKind));

  // Attach the in-repo consumers each breaking change affects. For a RENAME, look up BOTH the old
  // id (`file::name`, resolved when the index is at the base) AND the new id (resolved when the
  // index is at HEAD) so the broken consumers surface regardless of which side the index was built.
  const breaking = changes
    .filter((c) => c.class === 'breaking')
    .map((c) => {
      const ids = [`${c.file}::${c.name}`];
      if (c.changeKind === 'renamed' && c.rename) ids.push(`${c.rename.file}::${c.rename.to}`);
      const { consumers, truncated } = resolveConsumers(edgeStore, ids);
      return { ...c, consumers, consumersTruncated: truncated };
    });

  const overall: ChangeClass = overallClass(changes);
  const anyClassifiable = headFiles.some((f) => signatureClassifiable(f.language)) || baseFiles.some((f) => signatureClassifiable(f.language));

  // Honesty: consumers in unindexed/external downstreams are never visible.
  const extraCrossings = breaking.length > 0
    ? [{
        kind: 'unindexed-repo' as const,
        count: breaking.length,
        detail: 'Consumers of these breaking changes that live OUTSIDE any indexed repo (closed-source or external downstreams) are not visible; the listed consumers are in-repo only. Under federation, indexed sibling repos are also checked.',
      }]
    : [];

  return {
    overall,
    summary: {
      breaking: changes.filter((c) => c.class === 'breaking').length,
      potentiallyBreaking: changes.filter((c) => c.class === 'potentially-breaking').length,
      nonBreaking: changes.filter((c) => c.class === 'non-breaking').length,
    },
    changes,
    breaking,
    soundness: {
      posture: anyClassifiable
        ? 'Compatibility is classified from statically-available signatures; anything unprovable is potentially-breaking, never silently safe.'
        : 'No classifiable-language changes in the diff; signature compatibility was not assessed.',
      languages: 'Signature classification supported for TypeScript, JavaScript, Python; other languages fail-soft (surface membership only).',
    },
    extraCrossings,
  };
}

export async function computeCertifyPublicSurface(input: CertifyPublicSurfaceInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx?.callGraph) {
    return { error: 'No analysis found. Run analyze_codebase first.' };
  }
  if (input.baseRef && input.baseRef.trim().length > 0) {
    return diffSurface(absDir, ctx, input.baseRef.trim());
  }
  return listSurface(absDir, ctx, input.maxResults ?? 200);
}

export async function handleCertifyPublicSurface(input: CertifyPublicSurfaceInput): Promise<unknown> {
  return computeCertifyPublicSurface(input);
}
