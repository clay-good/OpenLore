/**
 * Content-hash-keyed memoization of Pass-1 extraction facts (change: optimize-hash-keyed-analyze).
 *
 * Pass 1 — per-file tree-sitter parsing and fact extraction — is a PURE function of
 * `(language, content)`. Nothing it produces depends on another file, on the clock, or on
 * anything outside the file's own bytes. That purity is what makes memoizing it sound: if the
 * bytes and the extracting code are both unchanged, re-parsing can only reproduce the answer
 * already on disk.
 *
 * So each file's Pass-1 output is stored keyed by
 *
 *     (file path, sha256(language + content), extractor stamp)
 *
 * and a later `analyze` reuses every row whose key still matches, re-extracting only the diff.
 * Global (cross-file) passes are untouched — they still run over the whole merged fact set.
 *
 * ## The stamp is the soundness boundary
 *
 * A memo is only as safe as its invalidation rule. The content hash covers the INPUT; the
 * stamp covers the FUNCTION — every input to extraction that is not the file's own bytes:
 *
 *  1. **OpenLore's own extraction code.** A digest over the source that implements Pass 1
 *     (see {@link STAMP_ROOTS}), so editing an extractor invalidates the cache with no
 *     version bump to remember. Deliberately over-broad: a root covers whole directories, so
 *     an unrelated edit inside one costs a re-extract. That error direction is free; the
 *     other one silently corrupts the graph. `pass1-fact-cache.test.ts` walks the real static
 *     import closure of the extraction entry point and fails if any module it reaches is
 *     outside these roots, so the coverage cannot rot as the analyzer grows.
 *  2. **The installed grammar versions.** The grammars are OPTIONAL dependencies loaded at
 *     runtime, so the same OpenLore build extracts differently depending on which are present
 *     and at what version — including the "grammar absent → this language yields nothing"
 *     case, which a cache must never freeze in.
 *
 * Anything the stamp cannot see is a stale-fact bug, which is why the stamp is computed from
 * evidence on disk rather than from a hand-maintained constant.
 *
 * ## What is deliberately not here
 *
 * No cross-machine cache sharing and no dependency graph of derived queries: facts are
 * memoized at exactly one boundary — per-file extraction — because that is where the cost is
 * and where the purity is already proven. `--force` (or `OPENLORE_NO_FACT_CACHE=1`) bypasses
 * the cache entirely and then repopulates it: the always-available escape, and the reference
 * output the reused lane is verified against.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FileExtractResult } from './call-graph-types.js';
import type { FunctionCfg } from './cfg.js';

/** Set to `1`/`true` to bypass the fact cache for reads (the non-CLI escape hatch). */
const NO_FACT_CACHE_ENV = 'OPENLORE_NO_FACT_CACHE';

/**
 * Serialized-payload format version. Bump when {@link serializeFacts} changes shape — it is
 * folded into the stamp, so a bump invalidates every row written by an older format.
 */
const FACT_FORMAT_VERSION = 1;

/** One file's Pass-1 facts as they are stored. */
export interface Pass1FactRow {
  filePath: string;
  /** sha256 over `language + '\0' + content` — a language reclassification is a miss too. */
  contentHash: string;
  /** The serialized {@link FileExtractResult}, or `null` for "no extractor for this language". */
  facts: string;
}

/** The Pass-1 memo, as {@link CallGraphBuilder} sees it. Production wires the EdgeStore-backed one. */
export interface Pass1FactCache {
  /** Cached facts for this file's exact content, or `undefined` on a miss. */
  lookup(file: ExtractionInput): { facts: FileExtractResult | undefined } | undefined;
  /** Record what a fresh extraction produced for this file's exact content. */
  record(file: ExtractionInput, facts: FileExtractResult | undefined): void;
}

/** The Pass-1 input record (kept structural so this module stays dependency-light). */
export interface ExtractionInput {
  path: string;
  content: string;
  language: string;
}

/** How many files the last build reused vs. re-extracted — always disclosed, never silent. */
export interface Pass1CacheDisclosure {
  reused: number;
  extracted: number;
}

// ── Key ──────────────────────────────────────────────────────────────────────

/**
 * The content key for one file. The LANGUAGE is hashed with the content because the same
 * bytes extract differently under a different classification (a `.h` resolved as C vs C++,
 * an HTML file whose inline scripts are blanked into JavaScript), and the caller's content is
 * the post-transform text, so the hash covers the transform too.
 */
export function factKey(file: ExtractionInput): string {
  return createHash('sha256').update(file.language).update('\0').update(file.content).digest('hex');
}

// ── Serialization ────────────────────────────────────────────────────────────

/**
 * Wire shape. Keys are terse because this is written once per file per analyze and read back
 * whole; `cfg` is an array of entries because it is a `Map` in memory and JSON has no Maps.
 */
interface SerializedFacts {
  v: number;
  n: FileExtractResult['nodes'];
  e: FileExtractResult['rawEdges'];
  c?: Array<[string, FunctionCfg]>;
  s?: FileExtractResult['style'];
  h?: FileExtractResult['parseHealth'];
}

/**
 * Serialize one file's extractor output. `undefined` (a language with no extractor) is stored
 * as the JSON literal `null` — a real, reusable answer, not an absence, so a repo full of
 * unsupported files does not re-dispatch them on every run.
 *
 * Every field is plain data: the same values already cross a `structuredClone` boundary to
 * reach the extraction workers, and the CFG overlay is documented to retain no AST nodes.
 */
export function serializeFacts(facts: FileExtractResult | undefined): string {
  if (!facts) return 'null';
  const payload: SerializedFacts = { v: FACT_FORMAT_VERSION, n: facts.nodes, e: facts.rawEdges };
  if (facts.cfg && facts.cfg.size > 0) payload.c = [...facts.cfg];
  if (facts.style) payload.s = facts.style;
  if (facts.parseHealth) payload.h = facts.parseHealth;
  return JSON.stringify(payload);
}

/**
 * Rebuild one file's extractor output from a stored row. Returns a miss (`undefined` outer)
 * for anything unreadable or written under a different payload format — a cache is never
 * allowed to be the reason a build produces different facts, so every doubt re-extracts.
 */
export function deserializeFacts(raw: string): { facts: FileExtractResult | undefined } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null) return { facts: undefined };
  const p = parsed as SerializedFacts;
  if (!p || typeof p !== 'object' || p.v !== FACT_FORMAT_VERSION || !Array.isArray(p.n) || !Array.isArray(p.e)) {
    return undefined;
  }
  const facts: FileExtractResult = { nodes: p.n, rawEdges: p.e };
  if (p.c) facts.cfg = new Map(p.c);
  if (p.s) facts.style = p.s;
  if (p.h) facts.parseHealth = p.h;
  return { facts };
}

// ── Stamp ────────────────────────────────────────────────────────────────────

/**
 * Directories and files whose contents define what Pass-1 extraction computes, relative to
 * this module's own directory (`<root>/core/analyzer`, whether that root is `src/` under a
 * loader or `dist/` when installed).
 *
 * Over-broad on purpose — see the module doc. Kept honest by the import-closure test rather
 * than by anyone remembering to update it.
 */
const STAMP_ROOTS = ['.', '../scip', '../../utils', '../../types', '../../constants'];

/** Files under a stamp root that cannot affect extraction output. */
function isStampable(name: string): boolean {
  if (name.endsWith('.d.ts') || name.endsWith('.map')) return false;
  if (/\.(test|spec)\.[cm]?[jt]s$/.test(name)) return false;
  return /\.[cm]?[jt]s$/.test(name);
}

/** Directories under a stamp root that hold no extraction code. */
const SKIP_DIRS = new Set(['__tests__', '__snapshots__', 'fixtures', 'node_modules']);

function collectStampFiles(root: string, out: string[]): void {
  let entries: Array<import('node:fs').Dirent<string>>;
  try {
    entries = readdirSync(root, { withFileTypes: true, encoding: 'utf-8' });
  } catch {
    return; // an absent root (a layout that does not ship it) contributes nothing
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectStampFiles(full, out);
    } else if (isStampable(entry.name)) {
      out.push(full);
    }
  }
}

/**
 * Grammar packages: OpenLore's own declared dependencies whose name names tree-sitter. Read
 * from the manifest rather than hard-coded so a newly supported language is stamped the day
 * its grammar is declared, not the day someone remembers this list.
 */
function grammarPackageNames(moduleDir: string): string[] {
  try {
    // `<root>/core/analyzer` → the package manifest, for both the `src/` and `dist/` layouts.
    const pkg = JSON.parse(readFileSync(join(moduleDir, '../../../package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };
    return [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ].filter((n) => n.includes('tree-sitter')).sort();
  } catch {
    return [];
  }
}

/**
 * The installed version of each grammar package, or `absent` for one that is not installed.
 * "Absent" is a first-class part of the key: a language with no grammar extracts nothing, and
 * installing the grammar later must not keep serving that nothing from cache.
 */
function grammarVersions(require: NodeRequire, moduleDir: string): string[] {
  return grammarPackageNames(moduleDir).map((name) => {
    try {
      const pkg = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf-8')) as { version?: string };
      return `${name}@${pkg.version ?? 'unknown'}`;
    } catch {
      return `${name}@absent`;
    }
  });
}

/**
 * Digest the code under `roots` (resolved relative to `baseDir`).
 *
 * Deliberately position-independent: a file contributes its path RELATIVE to `baseDir` plus
 * its content, so the same code installed at two different absolute locations digests
 * identically — otherwise every user's cache would key on their own home directory.
 *
 * Never throws. A root that does not exist contributes nothing (a layout that does not ship
 * it), and a file that cannot be read contributes an explicit unreadable marker rather than
 * vanishing — a file silently dropping out of the digest would make the stamp LESS specific,
 * which is the one direction a cache key must never move.
 */
export function digestStampRoots(baseDir: string, roots: readonly string[]): string {
  const files: string[] = [];
  for (const root of roots) {
    const resolved = join(baseDir, root);
    // A root may name a file whose extension depends on the layout (`../../constants`).
    let matchedAsFile = false;
    for (const ext of ['.js', '.ts', '.cjs', '.mjs']) {
      try {
        readFileSync(resolved + ext);
        files.push(resolved + ext);
        matchedAsFile = true;
      } catch {
        /* not this extension */
      }
    }
    if (!matchedAsFile) collectStampFiles(resolved, files);
  }

  const rel = files.map((f) => [relative(baseDir, f).split(sep).join('/'), f] as const);
  rel.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const hash = createHash('sha256');
  for (const [relPath, full] of rel) {
    hash.update(relPath);
    hash.update('\0');
    try {
      hash.update(createHash('sha256').update(readFileSync(full)).digest('hex'));
    } catch {
      hash.update('<unreadable>');
    }
    hash.update('\n');
  }
  return hash.digest('hex');
}

let cachedStamp: string | undefined;

/**
 * The extractor version stamp for this process: a digest over the extraction code and the
 * installed grammars. Computed once — it cannot change while the process runs, and every
 * analyze in a long-lived daemon would otherwise re-read the same few hundred files.
 *
 * Never throws: an unreadable root or package simply contributes nothing to the digest. The
 * failure mode of a partial stamp is over-reuse, so anything that makes the stamp LESS
 * specific must be impossible — hence the roots are read whole, and a read error on an
 * individual file is folded in as an explicit marker rather than skipped silently.
 */
export function computeExtractorStamp(): string {
  if (cachedStamp) return cachedStamp;
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const hash = createHash('sha256');
  hash.update(`format=${FACT_FORMAT_VERSION}\n`);
  hash.update(digestStampRoots(moduleDir, STAMP_ROOTS));
  hash.update('\n');

  const require = createRequire(import.meta.url);
  for (const g of grammarVersions(require, moduleDir)) hash.update(`${g}\n`);

  cachedStamp = hash.digest('hex');
  return cachedStamp;
}

/** Test-only: recompute the stamp on the next call. */
export function __resetExtractorStampForTests(): void {
  cachedStamp = undefined;
}

/** The stamp roots, for the import-closure coverage test. */
export const __STAMP_ROOTS_FOR_TESTS = STAMP_ROOTS;

// ── EdgeStore-backed cache ───────────────────────────────────────────────────

/** The subset of the graph store this cache needs — narrow so tests need no SQLite. */
export interface Pass1FactStorage {
  getPass1Facts(filePath: string, contentHash: string, stamp: string): string | undefined;
}

/**
 * The production cache: reads through to the graph store, buffers writes.
 *
 * Writes are buffered rather than written through because the store handle that may WRITE
 * only exists at the end of an analyze (the same handle that rebuilds the graph). Opening a
 * second write handle earlier would widen the window in which a concurrent reader sees a
 * half-rebuilt store, which is a worse trade than holding the rows in memory — and on the
 * incremental runs this change exists for, the buffer holds only the diff.
 */
export class BufferedPass1FactCache implements Pass1FactCache {
  private readonly keys = new Map<string, string>();
  private readonly writes: Pass1FactRow[] = [];

  constructor(
    private readonly storage: Pass1FactStorage | null,
    private readonly stamp: string,
    /** When true, every lookup misses; writes still accumulate so the cache repopulates. */
    private readonly bypassReads = false,
  ) {}

  lookup(file: ExtractionInput): { facts: FileExtractResult | undefined } | undefined {
    const key = factKey(file);
    this.keys.set(file.path, key);
    if (this.bypassReads || !this.storage) return undefined;
    let raw: string | undefined;
    try {
      raw = this.storage.getPass1Facts(file.path, key, this.stamp);
    } catch {
      return undefined; // an unreadable store is a miss, never a failed build
    }
    if (raw === undefined) return undefined;
    return deserializeFacts(raw);
  }

  record(file: ExtractionInput, facts: FileExtractResult | undefined): void {
    const contentHash = this.keys.get(file.path) ?? factKey(file);
    this.writes.push({ filePath: file.path, contentHash, facts: serializeFacts(facts) });
  }

  /** The rows to persist, and the stamp they were computed under. */
  drain(): { stamp: string; rows: Pass1FactRow[] } {
    return { stamp: this.stamp, rows: this.writes };
  }
}

/** True when the environment escape hatch is set. */
export function factCacheDisabledByEnv(): boolean {
  const v = process.env[NO_FACT_CACHE_ENV];
  return v === '1' || v === 'true';
}
