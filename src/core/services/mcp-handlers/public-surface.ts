/**
 * MCP handler: certify_public_surface (change: add-public-api-surface-contract).
 *
 * Two conclusion modes over a package/module's exported public surface:
 *  - No base ref → return the PUBLIC SURFACE: the exported symbols and their signatures.
 *  - A base ref  → return the BREAKING-CHANGE VERDICT for the current diff: each changed
 *    public symbol classified `breaking | non-breaking | potentially-breaking`, each
 *    breaking one paired with the consumers it breaks (in-repo, plus indexed sibling repos
 *    under `federation`) and split into `breaking-consumed` / `breaking-unconsumed-in-index`,
 *    plus an overall summary. Breaking findings accepted in the checked-in baseline are
 *    listed as accepted instead of as findings (change: add-public-surface-acceptance-baseline).
 *
 * Deterministic, no LLM, no type checker, no build. Conservative by construction: a
 * change that cannot be proven compatible from the available signatures is
 * `potentially-breaking`, never silently `non-breaking`. Renamed exports are reported
 * as renames (not remove+add) via the symbol-identity continuity map (change:
 * add-symbol-identity-continuity). External/unindexed consumers are disclosed as a
 * known-unknowable boundary rather than implied to be absent.
 */

import { readFile, realpath } from 'node:fs/promises';
import { readDependencyGraphCached } from './artifact-cache.js';
import { readFileConfined } from '../../../utils/path-confinement.js';
import { isAbsolute, join, relative, sep } from 'node:path';
import { gitPathArgs } from '../../../utils/git-args.js';
import { validateDirectory, readCachedContext, diagnoseIndexUnservable } from './utils.js';
import { assembleBoundary, computeStaleness } from './confidence-boundary.js';
import { parseJSExports } from '../../analyzer/import-parser.js';
import { detectLanguage } from '../../analyzer/signature-extractor.js';
import { isTestFile } from '../../analyzer/test-file.js';
import { CallGraphBuilder, serializeCallGraph } from '../../analyzer/call-graph.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';
import { hashSpan } from '../../decisions/anchor.js';
import { execFileGit as execFileAsync } from '../../../utils/git-exec.js';
import {
  computeContinuity,
  normalizedBodyHash,
  type DisappearedSymbol,
  type AppearedSymbol,
} from '../../analyzer/continuity.js';
import {
  classifySignatureChange,
  parseSignature,
  signatureClassifiable,
  overallClass,
  suggestedBump,
  BREAKING_SURFACE_RULE_CODES,
  type SurfaceChange,
  type SurfaceKind,
  type ChangeClass,
  type SuggestedBump,
} from '../../analyzer/public-surface.js';
import { FINDING_CODE_REGISTRY, type GovernanceFinding } from './enforcement-policy.js';
import { resolveFederationScope, findCrossRepoConsumersBatch } from '../../federation/resolver.js';
import { PUBLIC_SURFACE_BASELINE_REL_PATH } from '../../../constants.js';
import {
  anchorsToCheck,
  applyAcceptedBaseline,
  readAcceptedBaseline,
  type AcceptedBreakage,
  type DecisionCurrency,
} from './public-surface-baseline.js';
import { verifyDecisionCurrent } from './claim-verification.js';
import { loadDecisionStore } from '../../decisions/store.js';
import type { PendingDecision } from '../../../types/index.js';


const MAX_SURFACE = 500;
const MAX_CONSUMERS = 25;
const SOURCE_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py)$/i;
/** Code extensions the canonical language map does not know (C/C++ headers, Python stubs, …). */
const EXTRA_CODE_RE = /\.(pyi|pyx|pxd|pyw|hxx|hh|inl|ipp|tpp|cu|cuh|mm|m|fs|fsi|fsx|vb|erl|hrl|clj|cljs|cljc|hs|lhs|ml|mli|zig|nim|jl|r|groovy|razor|cshtml|erb|rake|gemspec|coffee|pl|pm|ps1|psm1|zsh|fish|bat|cmd|sol|elm|purs|gleam|cr|hx|tcl|wat|move)$/i;

/**
 * A code file in a language whose public signatures are not classified. It never reaches the
 * classifier, so a diff that changes one cannot earn a `minor`/`patch` bump on its evidence. Built
 * from the canonical language map (so a Vue or shell file counts) plus a few extensions it does not
 * know; infrastructure files (Terraform, Bicep), tests, and non-code files do not count.
 */
function isUnclassifiedCode(path: string): boolean {
  if (SOURCE_RE.test(path) || isTestFile(path)) return false;
  const language = detectLanguage(path);
  if (language === 'Terraform' || language === 'Bicep') return false;
  return language !== 'unknown' || EXTRA_CODE_RE.test(path);
}

export interface CertifyPublicSurfaceInput {
  directory: string;
  /** Diff the working tree's public surface against this ref. Omit to return the surface itself. */
  baseRef?: string;
  /** Cap the surface listing (surface mode). */
  maxResults?: number;
  /**
   * Certification is fatal on an unresolvable base by default: a verdict computed
   * against a base the caller did not ask for is not a certificate. Set this to accept
   * the disclosed main → master → HEAD~1 fallback instead (fix-cli-conclusion-honesty).
   */
  allowBaseFallback?: boolean;
  /** Opt-in: count consumers in indexed sibling repos (`.openlore/federation.json`) too. */
  federation?: boolean;
  /** Limit the federation census to these registry repo names (default: all). */
  federationRepos?: string[];
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
    // The shared `parseJSExports` now recognizes modifier-prefixed exports directly —
    // `export async function` / `export function* gen` / `export abstract class`,
    // `export default async function foo` (name `foo`, not `async`), and the real name
    // of a `export const enum X` — so no per-consumer recovery is needed here. The
    // RESERVED_NAMES filter stays as a defense-in-depth glitch guard (e.g. an anonymous
    // `export default function () {}` still yields the bare `function` token).
    const names = new Set(
      parseJSExports(content)
        .filter((e) => !e.isReExport && e.name && e.name !== 'default' && !RESERVED_NAMES.has(e.name))
        .map((e) => e.name),
    );
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

/**
 * The base line that declares exported `name` (a const, class, type, or an export list naming it),
 * whitespace-collapsed and bounded, so a later removal of a DIFFERENT declaration under the same name
 * is a different break. Literals and comments are blanked first, so an `export` inside a string or
 * comment never matches. Undefined when no single line can be found.
 */
function declarationLine(rawContent: string, name: string, language: string): string | undefined {
  const blanked = blankLiterals(rawContent).split('\n');
  const raw = rawContent.split('\n');
  const id = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = language === 'Python'
    ? new RegExp(`^\\s*(?:async\\s+)?(?:def|class)\\s+${id}\\b`)
    : new RegExp(`\\bexport\\b.*(?:\\b(?:const|let|var|class|interface|type|enum|function|namespace)\\s+${id}\\b|[{,]\\s*${id}\\s*[,}]|\\bas\\s+${id}\\b)`);
  // Bounded per line: a minified line is not a declaration worth quadratic regex work.
  const index = blanked.findIndex((line) => line.length <= 2_000 && pattern.test(line));
  if (index < 0) return undefined;
  const line = raw[index].replace(/\s+/g, ' ').trim();
  // A variable's initializer is its value, not its contract, and may be a literal that has no place
  // in a committed baseline: keep only the declaration head (`export const LIMIT: number`).
  const head = /\b(?:const|let|var)\s/.test(blanked[index]) ? line.replace(/\s*=(?!>).*$/, '') : line;
  return head.slice(0, 300);
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
  let snap: SerializedCallGraph | null;
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
  /**
   * How the consumer binds the symbol: a resolved `call`; an `unresolved-call` by name from a file
   * that imports it (the index was built after the symbol went away); an `import` of the symbol by
   * name (directly or through a re-exporting module) by a file with no call the index could
   * attribute (a const, class, or type is never a call target); or a `module-import` — a default,
   * namespace, or whole-module import of the defining module, which MAY use the symbol.
   */
  via: 'call' | 'unresolved-call' | 'import' | 'module-import';
}

function callerToConsumer(callerId: string, via: Consumer['via']): Consumer {
  const idx = callerId.lastIndexOf('::');
  if (idx < 0) return { id: callerId, name: callerId, file: '', via };
  return { id: callerId, name: callerId.slice(idx + 2), file: callerId.slice(0, idx), via };
}

interface EdgeStoreLike {
  getCallers(nodeId: string): Array<{ callerId: string; calleeName?: string }>;
  /** Unresolved (`external`) call sites to this exact name. */
  getExternalConsumers?(symbolName: string): Array<{ callerId: string }>;
}

/** Files that import `name` from `file` (by name, or as a whole module), from the dependency graph. */
export type ImporterLookup = (file: string, name: string) => ReadonlyArray<{ file: string; via: 'import' | 'module-import' }>;

/**
 * In-repo consumers of a breaking change, deduped + bounded; no index → empty (disclosed upstream).
 *
 * - Resolved callers of `nodeIds` — the symbol under the name its consumers bind (for a rename, the
 *   OLD name: callers already moved to the new name are not broken), at its head and base paths.
 * - Files that import the symbol from `files`. Without these, a removed const, class, or type (never
 *   a call target) and any symbol whose index was rebuilt after the change would read as unconsumed.
 * - For a symbol gone from HEAD under `unresolvedName`, the unresolved calls to that name made from
 *   those importing files or from the defining file itself — the precise callers once the index no
 *   longer resolves the symbol. Restricted to those files so an unrelated `parse` never counts.
 * - With `crossFileOnly` (a visibility reduction: the symbol is still defined, so only other files
 *   break), consumers in the defining file are dropped.
 * An importing file already represented by a function-level consumer is not listed again.
 */
function resolveConsumers(
  edgeStore: EdgeStoreLike | undefined,
  nodeIds: readonly string[],
  imported: { files: string[]; name: string; unresolvedName?: string; crossFileOnly?: boolean },
  importersOf?: ImporterLookup,
): { consumers: Consumer[]; truncated: number } {
  const byId = new Map<string, Consumer>();
  const add = (c: Consumer): void => {
    if (imported.crossFileOnly && imported.files.includes(c.file)) return;
    if (!byId.has(c.id)) byId.set(c.id, c);
  };
  for (const nodeId of nodeIds) {
    for (const e of edgeStore ? edgeStore.getCallers(nodeId) : []) add(callerToConsumer(e.callerId, 'call'));
  }
  const importingFiles = new Map<string, 'import' | 'module-import'>();
  for (const file of importersOf ? imported.files : []) {
    for (const importer of importersOf!(file, imported.name)) {
      if (imported.files.includes(importer.file)) continue;
      // A by-name import is stronger evidence than a whole-module one for the same file.
      if (importingFiles.get(importer.file) !== 'import') importingFiles.set(importer.file, importer.via);
    }
  }
  if (imported.unresolvedName && edgeStore?.getExternalConsumers) {
    for (const e of edgeStore.getExternalConsumers(imported.unresolvedName)) {
      const c = callerToConsumer(e.callerId, 'unresolved-call');
      if (importingFiles.has(c.file) || imported.files.includes(c.file)) add(c);
    }
  }
  const filesWithCallers = new Set([...byId.values()].map((c) => c.file));
  for (const [file, via] of importingFiles) {
    if (!filesWithCallers.has(file)) add({ id: file, name: file, file, via });
  }
  const all = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { consumers: all.slice(0, MAX_CONSUMERS), truncated: Math.max(0, all.length - MAX_CONSUMERS) };
}

/**
 * Build an {@link ImporterLookup} from `.openlore/analysis/dependency-graph.json`. Edges carry
 * absolute source/target paths, the local binding names (`importedNames`), and — for statically
 * named imports — the names bound FROM the target (`importedSourceNames`, aliases resolved). The
 * lookup keys on the source names, so `import { parse as p }` counts for `parse` and
 * `import { keep as helper }` never counts for `helper`. An import whose bindings the parser could
 * not name (default, namespace, star, dynamic) or a Python import of the module itself is a
 * `module-import` of every export. By-name imports are followed through re-exporting modules
 * (a barrel) while the index still records the re-export. Absent or unusable → undefined, and the
 * census falls back to call edges alone. Read through the shared bounded reader.
 */
async function loadImporterLookup(absDir: string): Promise<ImporterLookup | undefined> {
  type GraphNode = { id?: unknown; file?: { path?: unknown; absolutePath?: unknown }; exports?: unknown };
  const graph = await readDependencyGraphCached<{ nodes?: GraphNode[]; edges?: Array<Record<string, unknown>> }>(
    join(absDir, '.openlore/analysis/dependency-graph.json'),
  ).catch(() => null);
  if (!graph || !Array.isArray(graph.edges) || !Array.isArray(graph.nodes)) return undefined;
  // The graph stores absolute paths from wherever the index was built. Relativize against this
  // checkout, its real path, and the root the index was built at (derived from any node whose
  // absolute path ends with its relative path), so a moved or copied checkout still resolves.
  const roots = [absDir];
  try { const real = await realpath(absDir); if (real !== absDir) roots.push(real); } catch { /* keep absDir */ }
  const filePaths = new Set<string>();
  for (const node of graph.nodes) {
    const path = node.file?.path;
    const abs = typeof node.file?.absolutePath === 'string' ? node.file.absolutePath : node.id;
    if (typeof path !== 'string') continue;
    filePaths.add(path.split(sep).join('/'));
    if (typeof abs === 'string' && roots.length < 4 && abs.endsWith(path) && abs.length > path.length) {
      const root = abs.slice(0, abs.length - path.length).replace(/[\\/]+$/, '');
      if (root && !roots.includes(root)) roots.push(root);
    }
  }
  const rel = (p: string): string | null => {
    for (const root of roots) {
      const r = relative(root, p);
      if (r && !r.startsWith('..') && !isAbsolute(r)) return r.split(sep).join('/');
    }
    return null;
  };
  const byName = new Map<string, Set<string>>();
  const byModule = new Map<string, Set<string>>();
  const put = (index: Map<string, Set<string>>, key: string, source: string): void => {
    (index.get(key) ?? index.set(key, new Set()).get(key)!).add(source);
  };
  for (const edge of graph.edges) {
    if (edge.httpEdge !== undefined || edge.isCallEdge === true) continue; // not an import
    if (typeof edge.source !== 'string' || typeof edge.target !== 'string' || !Array.isArray(edge.importedNames)) continue;
    const source = rel(edge.source);
    const target = rel(edge.target);
    if (!source || !target || source === target) continue;
    const local = edge.importedNames.filter((n): n is string => typeof n === 'string');
    const named = Array.isArray(edge.importedSourceNames)
      ? edge.importedSourceNames.filter((n): n is string => typeof n === 'string')
      : null;
    const moduleName = target.replace(/\/__init__\.py$/, '').replace(/\.py$/, '').split('/').pop();
    for (const name of named ?? []) {
      if (target.endsWith('.py') && name === moduleName) { put(byModule, target, source); continue; } // `from pkg import util`
      put(byName, `${target}::${name}`, source);
      // `from . import types` / `from pkg import types` targets the package's `__init__.py`; when a
      // submodule of that name exists, the import binds that module whole.
      if (target.endsWith('__init__.py')) {
        const pkg = target.slice(0, -'__init__.py'.length);
        for (const sub of [`${pkg}${name}.py`, `${pkg}${name}/__init__.py`]) if (filePaths.has(sub)) put(byModule, sub, source);
      }
    }
    // Bindings the parser could not name (a default or namespace binding beside named ones, or no
    // named list at all) may use any export. A side-effect import binds nothing.
    if (local.length > (named?.length ?? 0)) put(byModule, target, source);
  }
  // Re-exports (`export { x } from './a'`, `export * from './a'`) are recorded on the barrel's node,
  // not as edges: index them as "the barrel passes `x` (or everything) on from `a`".
  const reExports = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    const barrel = typeof node.file?.path === 'string' ? node.file.path.split(sep).join('/') : null;
    if (!barrel || !Array.isArray(node.exports)) continue;
    for (const exp of node.exports as Array<{ name?: unknown; isReExport?: unknown; reExportSource?: unknown }>) {
      if (exp.isReExport !== true || typeof exp.name !== 'string' || typeof exp.reExportSource !== 'string') continue;
      const from = resolveModule(barrel, exp.reExportSource, filePaths);
      if (from && from !== barrel) put(reExports, `${from}::${exp.name}`, barrel);
    }
  }
  return (file, name) => {
    const found = new Map<string, 'import' | 'module-import'>();
    const seen = new Set<string>();
    const queue = [file];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const importer of byName.get(`${current}::${name}`) ?? []) found.set(importer, 'import');
      for (const importer of byModule.get(current) ?? []) if (!found.has(importer)) found.set(importer, 'module-import');
      // A barrel that re-exports the name (or everything) passes it on under the same name. A named
      // re-export (`export { x } from`) itself breaks when `x` goes away; `export *` binds nothing,
      // so only the files importing through it count.
      for (const barrel of reExports.get(`${current}::${name}`) ?? []) {
        found.set(barrel, 'import');
        queue.push(barrel);
      }
      for (const barrel of reExports.get(`${current}::*`) ?? []) queue.push(barrel);
    }
    return [...found].map(([f, via]) => ({ file: f, via })).sort((x, y) => x.file.localeCompare(y.file));
  };
}

/** Resolve a relative module specifier from `fromFile` to a known file path, or null. */
function resolveModule(fromFile: string, specifier: string, files: ReadonlySet<string>): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = join(fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '.', specifier).split(sep).join('/');
  const stem = base.replace(/\.(m|c)?js$|\.jsx$/, '');
  const candidates = [base, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py'].map((ext) => stem + ext),
    ...['index.ts', 'index.tsx', 'index.js', '__init__.py'].map((f) => `${stem}/${f}`)];
  return candidates.find((c) => files.has(c)) ?? null;
}

/**
 * The consumer-weighted split of a breaking change (change: add-public-surface-acceptance-baseline):
 * `breaking-consumed` when at least one indexed consumer binds the symbol, else
 * `breaking-unconsumed-in-index`. The consumer list is the evidence; there is no score. Zero indexed
 * consumers is never "safe" — the external-consumer boundary is disclosed on both.
 */
export type BreakingWeight = 'breaking-consumed' | 'breaking-unconsumed-in-index';

interface CrossRepoConsumerOut {
  repo: string;
  name: string;
  file: string;
}

export type WeightedBreakingChange = SurfaceChange & {
  consumers: Consumer[];
  consumersTruncated: number;
  /** Consumers in indexed sibling repos (federation scope only), matched by symbol name. */
  crossRepoConsumers?: CrossRepoConsumerOut[];
  /** Cross-repo consumers found but not listed (a cap). */
  crossRepoConsumersTruncated?: number;
  /** In-repo plus cross-repo consumers, including any dropped by a cap. */
  consumerCount: number;
  breakingClass: BreakingWeight;
};

function weigh<T extends SurfaceChange & { consumers: Consumer[]; consumersTruncated: number; crossRepoConsumers?: CrossRepoConsumerOut[] }>(
  change: T,
  crossRepoTruncated = 0,
): T & { consumerCount: number; breakingClass: BreakingWeight } {
  const consumerCount = change.consumers.length + change.consumersTruncated + (change.crossRepoConsumers?.length ?? 0) + crossRepoTruncated;
  return { ...change, consumerCount, breakingClass: consumerCount > 0 ? 'breaking-consumed' : 'breaking-unconsumed-in-index' };
}

function weightSummary(breaking: readonly WeightedBreakingChange[]): { breakingConsumed: number; breakingUnconsumedInIndex: number } {
  return {
    breakingConsumed: breaking.filter((b) => b.breakingClass === 'breaking-consumed').length,
    breakingUnconsumedInIndex: breaking.filter((b) => b.breakingClass === 'breaking-unconsumed-in-index').length,
  };
}

/** The external-consumer boundary for `count` breaking changes, stated for the census actually run. */
function consumerBoundary(
  count: number,
  census: 'in-repo' | 'federation' | 'federation-none-consulted',
): Array<{ kind: 'unindexed-repo'; count: number; detail: string }> {
  if (count === 0) return [];
  return [{
    kind: 'unindexed-repo',
    count,
    detail: census === 'federation-none-consulted'
      ? 'Consumers of these breaking changes that live OUTSIDE this repo are not visible: federation was requested, but no sibling repo was consulted (see consumerCensus), so the listed consumers are in-repo only. Zero listed consumers does not mean no consumer exists.'
      : census === 'federation'
      ? 'Consumers of these breaking changes that live OUTSIDE any indexed repo (closed-source or external downstreams), or in a federated repo that was skipped, are not visible. Federated sibling repos were checked by symbol name (see consumerCensus); zero listed consumers does not mean no consumer exists.'
      : 'Consumers of these breaking changes that live OUTSIDE this repo (closed-source or external downstreams, and sibling repositories) are not visible; the listed consumers are in-repo only. Pass federation to also check indexed sibling repos; zero listed consumers does not mean no consumer exists.',
  }];
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

async function changedSourceFiles(absDir: string, base: string): Promise<{ files: Array<{ path: string; oldPath?: string; status: string }>; unassessedCodeFiles: number }> {
  const { getChangedFiles } = await import('../../drift/git-diff.js');
  const diff = await getChangedFiles({ rootPath: absDir, baseRef: base, includeUnstaged: true });
  // A test file is not part of the public API surface — exclude it (it also tends to embed
  // `export …` strings in fixtures that would otherwise read as phantom contract symbols).
  const eligible = (p: string): boolean => SOURCE_RE.test(p) && !isTestFile(p);
  const unassessed = new Set<string>();
  const noteUnassessed = (p: string): void => { if (isUnclassifiedCode(p)) unassessed.add(p); };
  // A rename counts both names: `lib.go` → `lib.txt` removes Go code the classifier never read.
  for (const f of diff.files) { noteUnassessed(f.path); if (f.oldPath) noteUnassessed(f.oldPath); }
  const out = diff.files
    .filter((f) => eligible(f.path))
    .map((f) => ({ path: f.path, status: f.status as string, ...(f.oldPath ? { oldPath: f.oldPath } : {}) }));
  const seen = new Set(out.map((c) => c.path));
  try {
    const { stdout } = await execFileAsync('git', gitPathArgs('ls-files', '--others', '--exclude-standard'), { cwd: absDir, maxBuffer: 16 * 1024 * 1024 });
    for (const path of stdout.split('\n').map((s) => s.trim()).filter(Boolean)) {
      if (eligible(path) && !seen.has(path)) { seen.add(path); out.push({ path, status: 'added' }); }
      noteUnassessed(path);
    }
  } catch { /* best-effort */ }
  return { files: out, unassessedCodeFiles: unassessed.size };
}

async function diffSurface(
  absDir: string,
  ctx: Awaited<ReturnType<typeof readCachedContext>>,
  baseRef: string,
  allowBaseFallback: boolean,
  federation: { federation?: boolean; federationRepos?: string[] },
): Promise<unknown> {
  const { resolveBaseRefDisclosed, validateGitRef } = await import('../../drift/git-diff.js');
  try { validateGitRef(baseRef); } catch (e) { return { error: (e as Error).message }; }
  let base: Awaited<ReturnType<typeof resolveBaseRefDisclosed>>;
  try { base = await resolveBaseRefDisclosed(absDir, baseRef); } catch (e) { return { error: `cannot resolve base ref: ${(e as Error).message}` }; }
  // Certification is fatal on an unresolvable base: never certify against a base the
  // caller did not ask for (fix-cli-conclusion-honesty). --allow-base-fallback opts in.
  if (base.fellBack && !allowBaseFallback) {
    return { error: `base ref "${base.requested}" did not resolve — refusing to certify the public surface against a fallback base ("${base.resolved}"). Pass an existing ref, or --allow-base-fallback to accept the disclosed fallback.` };
  }
  const resolvedBase = base.resolved;
  const oldRef = await mergeBase(absDir, resolvedBase);

  const { files: changed, unassessedCodeFiles } = await changedSourceFiles(absDir, resolvedBase);
  // Read base + head content for every changed file.
  const baseFiles: Array<{ path: string; content: string; language: string }> = [];
  const headFiles: Array<{ path: string; content: string; language: string }> = [];
  for (const f of changed) {
    // `f.path` is git-derived; confine the working-tree read the way structural-diff.ts
    // and impact-certificate.ts confine the same value (defense-in-depth: safeJoin
    // guarantees no escape, and this file's contents reach the caller as signatures).
    const headContent = f.status === 'deleted'
      ? ''
      : await readFileConfined(absDir, f.path).catch(() => '');
    const baseContent = await fileAtRef(absDir, oldRef, f.oldPath ?? f.path);
    if (headContent) headFiles.push({ path: f.path, content: headContent, language: detectLanguage(f.path) });
    if (baseContent) baseFiles.push({ path: f.oldPath ?? f.path, content: baseContent, language: detectLanguage(f.oldPath ?? f.path) });
  }

  // Reconcile a renamed file: map base path → head path so (file,name) pairs line up.
  const headPathOf = new Map<string, string>();
  for (const f of changed) if (f.oldPath) headPathOf.set(f.oldPath, f.path);

  const importersOf = await loadImporterLookup(absDir);
  const { extraCrossings, ...diff } = await assembleSurfaceDiff(baseFiles, headFiles, headPathOf, ctx?.edgeStore as EdgeStoreLike | undefined, unassessedCodeFiles, importersOf);

  // Consumer census: in-repo always; indexed sibling repos too under federation scope.
  const fedScope = resolveFederationScope(absDir, federation);
  const census = await federatedCensus(fedScope, diff.breaking);
  const breaking = census.breaking;

  // Accepted-breakage baseline: honored entries leave `findings`, but stay listed.
  const baseline = await applyBaselineFile(absDir, diff.findings);

  return {
    mode: 'diff',
    base: resolvedBase,
    head: 'working tree',
    // An allowed fallback (base.fellBack was true but --allow-base-fallback was set)
    // is disclosed structurally so the verdict never hides the base it actually used.
    ...(base.fellBack ? { baseRefFallback: { requested: base.requested, resolved: resolvedBase } } : {}),
    ...diff,
    summary: { ...diff.summary, ...weightSummary(breaking), accepted: baseline?.accepted.length ?? 0 },
    breaking,
    findings: baseline?.findings ?? diff.findings,
    consumerCensus: {
      ...census.block,
      importEvidence: importersOf ? 'dependency-graph' : 'unavailable',
      inRepoCaveat: importersOf
        ? 'In-repo consumers are resolved calls plus imports from the dependency graph. Imports the analyzer does not resolve are not seen — for example Python absolute imports in a src layout, and imports through a whole-module re-export such as `module.exports = require(...)` or a package `__init__.py`; an aliased re-export is matched by its exported name; a default, namespace, or whole-module import counts as possible use.'
        : 'No usable dependency graph: in-repo consumers are resolved calls only, so a const, class, or type is never seen as consumed. Run analyze.',
    },
    ...(baseline ? { baseline: baseline.block } : {}),
    confidenceBoundary: assembleBoundary({
      staleness: await computeStaleness(absDir),
      integrity: ctx?.integrity,
      // "Checked sibling repos" is only true when at least one was actually read.
      extraCrossings: !fedScope.active
        ? extraCrossings
        : consumerBoundary(breaking.length, consultedAny(census.block) ? 'federation' : 'federation-none-consulted'),
    }),
  };
}

function consultedAny(block: Record<string, unknown>): boolean {
  return Array.isArray(block.reposConsulted) && block.reposConsulted.length > 0;
}

/** Add consumers in indexed sibling repos (federation scope) and re-weigh each breaking change. */
async function federatedCensus(
  fedScope: ReturnType<typeof resolveFederationScope>,
  breaking: readonly WeightedBreakingChange[],
): Promise<{ breaking: WeightedBreakingChange[]; block: Record<string, unknown> }> {
  if (!fedScope.active) return { breaking: [...breaking], block: { scope: 'in-repo' } };
  const block: Record<string, unknown> = {
    scope: 'federation',
    ...(fedScope.unknownNames.length > 0 ? { unknownRepos: fedScope.unknownNames } : {}),
  };
  if (breaking.length === 0) return { breaking: [], block: { ...block, reposConsulted: [], reposSkipped: [], caveats: [] } };
  // Consumers bind the name the symbol had at the base (for a rename, the old name). Matching is by
  // name, so two breaking changes that share a name share one cross-repo list — disclosed below.
  const names = [...new Set(breaking.map((b) => b.name))];
  const batch = await findCrossRepoConsumersBatch(fedScope, names, { maxConsumers: MAX_CONSUMERS * names.length });
  const weighed = breaking.map((b) => {
    const cross = (batch.bySymbol.get(b.name) ?? [])
      .map((c) => ({ repo: c.repo, name: c.caller.name, file: c.caller.file }))
      .sort((x, y) => x.repo.localeCompare(y.repo) || x.file.localeCompare(y.file) || x.name.localeCompare(y.name));
    const dropped = Math.max(0, cross.length - MAX_CONSUMERS) + (batch.truncatedBySymbol.get(b.name) ?? 0);
    return weigh({ ...b, crossRepoConsumers: cross.slice(0, MAX_CONSUMERS), ...(dropped > 0 ? { crossRepoConsumersTruncated: dropped } : {}) }, dropped);
  });
  const droppedTotal = names.reduce((sum, name) =>
    sum + Math.max(0, (batch.bySymbol.get(name)?.length ?? 0) - MAX_CONSUMERS) + (batch.truncatedBySymbol.get(name) ?? 0), 0);
  const nameCount = new Map<string, number>();
  for (const b of breaking) nameCount.set(b.name, (nameCount.get(b.name) ?? 0) + 1);
  const sharedNames = [...nameCount].filter(([, n]) => n > 1).map(([name]) => name).sort();
  return {
    breaking: weighed,
    block: {
      ...block,
      ...(sharedNames.length > 0 ? { sharedNames } : {}),
      reposConsulted: batch.coverage.reposConsulted.map((r) => r.name),
      reposSkipped: batch.coverage.reposSkipped.map((r) => ({ name: r.name, state: r.state, reason: r.reason })),
      // Found but not listed, over every name (each change lists at most MAX_CONSUMERS).
      ...(droppedTotal > 0 ? { truncated: droppedTotal } : {}),
      caveats: [
        ...batch.coverage.caveats,
        'Sibling repos are matched on their unresolved call sites only: an import, `new`, or a const or type use of the symbol there is not counted.',
        ...(sharedNames.length > 0
          ? [`Breaking changes sharing a name (${sharedNames.join(', ')}) share one cross-repo consumer list, because sibling repos are matched by name.`]
          : []),
      ],
    },
  };
}

/**
 * Read `.openlore/public-surface-baseline.jsonl` and apply it to `findings`. Returns null when the
 * file is absent. A file that cannot be read or parsed honors NOTHING (fail-closed) and says why.
 */
async function applyBaselineFile(
  absDir: string,
  findings: readonly GovernanceFinding[],
): Promise<{ findings: GovernanceFinding[]; accepted: AcceptedBreakage[]; block: Record<string, unknown> } | null> {
  let entries: AcceptedBreakage[];
  try {
    const read = await readAcceptedBaseline(absDir);
    if (!read.present) return null;
    entries = read.entries;
  } catch (error) {
    return {
      findings: [...findings],
      accepted: [],
      block: {
        path: PUBLIC_SURFACE_BASELINE_REL_PATH,
        error: `baseline ignored, no acceptance honored: ${error instanceof Error ? error.message : String(error)}`,
        accepted: [],
        stale: [],
        unmatched: [],
      },
    };
  }
  // Only anchors of entries that match a finding matter, and the store is read once for all of them.
  const currency = new Map<string, DecisionCurrency>();
  let store: Promise<{ decisions?: PendingDecision[] }> | undefined;
  const loadStore = (): Promise<{ decisions?: PendingDecision[] }> => (store ??= loadDecisionStore(absDir));
  for (const id of anchorsToCheck(findings, entries)) {
    currency.set(id, await decisionCurrency(absDir, id, loadStore));
  }
  const applied = applyAcceptedBaseline(findings, entries, currency);
  const accepted = applied.accepted.map(({ code, subject, discriminator, justification, decision }): AcceptedBreakage =>
    ({ code, subject, ...(discriminator ? { discriminator } : {}), justification, ...(decision ? { decision } : {}) }));
  return {
    findings: applied.findings,
    accepted,
    block: {
      path: PUBLIC_SURFACE_BASELINE_REL_PATH,
      entries: entries.length,
      accepted,
      stale: applied.stale,
      unmatched: applied.unmatched,
    },
  };
}

/** Is decision `id` current? The same decision-store check `verify_claim`'s `decision-current` runs. */
async function decisionCurrency(
  absDir: string,
  id: string,
  loadStore: () => Promise<{ decisions?: PendingDecision[] }>,
): Promise<DecisionCurrency> {
  try {
    const result = await verifyDecisionCurrent(absDir, id, loadStore) as {
      verdict?: string;
      reason?: string;
      receipt?: { decision?: { supersededBy?: string } };
    };
    if (result.verdict === 'confirmed') return { current: true };
    const supersededBy = result.receipt?.decision?.supersededBy;
    return {
      current: false,
      // One line: the reason quotes repository-controlled decision ids and titles.
      reason: (result.reason ?? `decision ${id} is not current`).replace(/\s+/g, ' ').slice(0, 500),
      ...(supersededBy ? { supersededBy } : {}),
    };
  } catch (error) {
    return { current: false, reason: `decision ${id} could not be checked: ${error instanceof Error ? error.message : String(error)}` };
  }
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
  /** Changed code files in a language whose signatures are not classified (they never reach this core). */
  unassessedCodeFiles = 0,
  /** Files importing a symbol, for the consumer census (see {@link resolveConsumers}). */
  importersOf?: ImporterLookup,
): Promise<{
  overall: ChangeClass;
  summary: { breaking: number; potentiallyBreaking: number; nonBreaking: number; breakingConsumed: number; breakingUnconsumedInIndex: number };
  changes: SurfaceChange[];
  breaking: WeightedBreakingChange[];
  suggestedBump: SuggestedBump | null;
  /** Why the bump is withheld, when `suggestedBump` is null. */
  suggestedBumpWithheld?: string;
  findings: GovernanceFinding[];
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
    const { class: cls, reasons, ruleCodes } = classifySignatureChange(base.signature, head.signature, head.language);
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
      ruleCodes,
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
      ruleCodes: ['export-renamed'],
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
      ruleCodes: [stillDefined ? 'export-visibility-reduced' : 'export-removed'],
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
      ruleCodes: ['export-added'],
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
  const baseContentByPath = new Map<string, { content: string; language: string }>();
  const baseNamesByPath = new Map<string, Set<string>>();
  for (const bf of baseFiles) {
    baseContentByPath.set(headPathOf.get(bf.path) ?? bf.path, { content: bf.content, language: bf.language });
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
      const base = baseContentByPath.get(path);
      const declared = base ? declarationLine(base.content, name, base.language) : undefined;
      changes.push({
        changeKind: 'removed',
        class: 'breaking',
        name,
        file: path,
        kind: 'unknown',
        ...(declared ? { before: declared } : {}),
        reasons: ['exported symbol was removed from the public surface (no signature available — non-function or aliased export)'],
        ruleCodes: ['export-removed'],
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
        ruleCodes: ['export-added'],
      });
    }
  }

  changes.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name) || a.changeKind.localeCompare(b.changeKind));

  const oldPathOf = new Map([...headPathOf].map(([oldPath, headPath]) => [headPath, oldPath]));
  // Attach the in-repo consumers each breaking change affects: the consumers of the name as it was
  // at the base. For a RENAME only the old name counts — a caller already on the new name is fine.
  const breaking = changes
    .filter((c) => c.class === 'breaking')
    .map((c) => {
      // An index built at the base keys the symbol by its OLD path when the defining file was renamed.
      const files = [...new Set([c.file, oldPathOf.get(c.file) ?? c.file, ...(c.rename ? [c.rename.file] : [])])];
      // The old name no longer exists at HEAD for a removal or a rename, so an index built after the
      // change keeps its callers only as unresolved calls to that name.
      const gone = c.changeKind === 'removed' || c.changeKind === 'renamed';
      const { consumers, truncated } = resolveConsumers(edgeStore, files.map((f) => `${f}::${c.name}`), {
        files,
        name: c.name,
        ...(gone ? { unresolvedName: c.name } : {}),
        ...(c.changeKind === 'visibility-reduced' ? { crossFileOnly: true } : {}),
      }, importersOf);
      return weigh({ ...c, consumers, consumersTruncated: truncated });
    });

  const overall: ChangeClass = overallClass(changes);
  const anyClassifiable = headFiles.some((f) => signatureClassifiable(f.language)) || baseFiles.some((f) => signatureClassifiable(f.language));

  // Honesty: consumers in unindexed/external downstreams are never visible.
  const extraCrossings = consumerBoundary(breaking.length, 'in-repo');

  return {
    overall,
    summary: {
      breaking: changes.filter((c) => c.class === 'breaking').length,
      potentiallyBreaking: changes.filter((c) => c.class === 'potentially-breaking').length,
      nonBreaking: changes.filter((c) => c.class === 'non-breaking').length,
      ...weightSummary(breaking),
    },
    changes,
    breaking,
    ...bumpVerdict(changes, unassessedCodeFiles === 0 && (anyClassifiable || (baseFiles.length === 0 && headFiles.length === 0)), unassessedCodeFiles),
    findings: publicSurfaceFindings(changes),
    soundness: {
      posture: anyClassifiable
        ? 'Compatibility is classified from statically-available signatures; anything unprovable is potentially-breaking, never silently safe.'
        : 'No classifiable-language changes in the diff; signature compatibility was not assessed.',
      languages: 'Signature classification supported for TypeScript, JavaScript, Python; other languages fail-soft (surface membership only).',
    },
    extraCrossings,
  };
}

const BREAKING_CODE_SET: ReadonlySet<string> = new Set(BREAKING_SURFACE_RULE_CODES);

/** The suggested bump plus, when it is withheld, the reason. */
function bumpVerdict(changes: readonly SurfaceChange[], signaturesAssessed: boolean, unassessedCodeFiles: number): { suggestedBump: SuggestedBump | null; suggestedBumpWithheld?: string } {
  const bump = suggestedBump(changes, signaturesAssessed);
  if (bump !== null) return { suggestedBump: bump };
  const unproven = changes.filter((c) => c.class === 'potentially-breaking').length;
  return {
    suggestedBump: null,
    suggestedBumpWithheld: unproven > 0
      ? `${unproven} change(s) could not be proven compatible (potentially-breaking)`
      : unassessedCodeFiles > 0
        ? `${unassessedCodeFiles} changed code file(s) are in a language whose signatures are not classified (for example Go or Rust), so compatibility was not assessed`
        : 'the changed files are in no signature-classifiable language, so compatibility was not assessed',
  };
}

/** Discriminators longer than this are replaced by a hash, so a baseline line stays reviewable. */
const MAX_DISCRIMINATOR_LENGTH = 300;

/**
 * A signature reduced to its contract: parameter names, types, optionality, rest, and return type,
 * without comments or formatting. A reformat or a comment keeps the discriminator, so an accepted
 * break does not report again for an edit that changed nothing. Names stay in: for untyped code
 * they are the only thing that tells `f(a, b) → f(a)` from `f(a, b) → f(b)`, and a renamed keyword
 * parameter is itself a break in Python. A signature the parser cannot read falls back to its
 * text with comments and spacing removed.
 */
function canonicalSignature(signature: string, language: string): string {
  const parsed = parseSignature(signature, language);
  const squash = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, '');
  if (parsed.confidence === 'unparsed') return squash(signature.replace(/\/\/[^\n]*/g, ''));
  const params = parsed.params.map((p) =>
    `${p.rest ? '...' : ''}${squash(p.name)}${p.optional && !p.rest ? '?' : ''}${p.type !== undefined ? `:${squash(p.type)}` : ''}`);
  return `(${params.join(',')})${parsed.returnType !== undefined ? `=>${squash(parsed.returnType)}` : ''}`;
}

/**
 * What exactly broke, so an acceptance of one break never covers a different break of the same
 * rule on the same symbol (change: add-public-surface-acceptance-baseline): the rename target for a
 * rename; the canonical before → after contract for a signature change; the removed contract (or,
 * for a const, class, or type, its base declaration line) for a removal or a visibility reduction —
 * a symbol that comes back and is removed again with a different contract is a new break.
 */
export function breakDiscriminator(change: SurfaceChange): string | undefined {
  let text: string | undefined;
  const language = /\.pyi?$/.test(change.file) ? 'Python' : 'TypeScript';
  if (change.changeKind === 'renamed' && change.rename) text = `renamed to ${change.rename.file}::${change.rename.to}`;
  else if (change.changeKind === 'signature' && (change.before || change.after)) {
    text = `${canonicalSignature(change.before ?? '', language)} => ${canonicalSignature(change.after ?? '', language)}`;
  } else if ((change.changeKind === 'removed' || change.changeKind === 'visibility-reduced') && change.before) {
    text = `was ${change.kind === 'unknown' ? change.before.replace(/\s+/g, ' ').trim() : canonicalSignature(change.before, language)}`;
  }
  if (text === undefined) return undefined;
  return text.length <= MAX_DISCRIMINATOR_LENGTH ? text : `sha256:${hashSpan(text)}`;
}

/**
 * Governance findings for a surface diff, one per rule code per changed symbol, so an
 * `enforcement.policy` can gate an individual rule (for example block `export-removed` but not
 * `param-type-narrowed`). Breaking-classed codes are severity `error`; `signature-unprovable` is a
 * `warning` a caller can choose to gate, so removing a type annotation cannot hide a narrowing from
 * a policy. `export-added` is not a finding. Deterministic order (the changes are already sorted).
 */
export function publicSurfaceFindings(changes: readonly SurfaceChange[]): GovernanceFinding[] {
  const findings: GovernanceFinding[] = [];
  for (const change of changes) {
    for (const code of change.ruleCodes) {
      const breaking = BREAKING_CODE_SET.has(code);
      if (!breaking && code !== 'signature-unprovable') continue;
      const subject = `${change.file}::${change.name}`;
      const discriminator = breakDiscriminator(change);
      findings.push({
        code,
        severity: breaking ? 'error' : 'warning',
        source: 'public-surface',
        subject,
        ...(discriminator ? { discriminator } : {}),
        // The reasons stay on the change itself; a finding names the rule, so a large diff does not
        // repeat every reason a third time in the response.
        message: `${change.changeKind} of exported "${change.name}" ${breaking ? 'breaks' : 'triggers'} rule ${code}`,
        // A function replacement: a subject such as `app/routes/$$id.tsx` must not be read as a `$` pattern.
        remediation: FINDING_CODE_REGISTRY[code]?.remediation?.replace('{subject}', () => subject),
        // A rename's finding points at the file that exists after the change.
        location: { path: change.rename?.file ?? change.file },
      });
    }
  }
  return findings;
}

export async function computeCertifyPublicSurface(input: CertifyPublicSurfaceInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx) return await diagnoseIndexUnservable(absDir);
  if (!ctx.callGraph) {
    return { error: 'No analysis found. Run analyze_codebase first.' };
  }
  if (input.baseRef && input.baseRef.trim().length > 0) {
    return diffSurface(absDir, ctx, input.baseRef.trim(), input.allowBaseFallback ?? false, {
      federation: input.federation,
      federationRepos: input.federationRepos,
    });
  }
  return listSurface(absDir, ctx, input.maxResults ?? 200);
}

export async function handleCertifyPublicSurface(input: CertifyPublicSurfaceInput): Promise<unknown> {
  return computeCertifyPublicSurface(input);
}
