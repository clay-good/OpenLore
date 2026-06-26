/**
 * Duplicate Code Detector
 *
 * Detects code clones using pure static analysis — no LLM calls:
 *   - Type 1 (exact):      identical code after whitespace/comment normalization
 *   - Type 2 (structural): same AST structure with renamed variables
 *   - Type 3 (near):       high Jaccard similarity on token n-grams (≥ 0.7)
 *
 * Requires a CallGraphResult for precise function boundaries (byte ranges).
 * Complexity: O(n) for Types 1-2, O(n²) for Type 3 (bounded by MAX_NEAR_FUNCTIONS).
 */

import { createHash } from 'node:crypto';
import type { CallGraphResult } from './call-graph.js';

// ============================================================================
// TYPES
// ============================================================================

export interface CloneInstance {
  file: string;
  functionName: string;
  className?: string;
  startLine: number;
  endLine: number;
}

/** 'exact' = identical after normalization, 'structural' = same shape renamed, 'near' = high Jaccard */
export type CloneType = 'exact' | 'structural' | 'near';

export interface CloneGroup {
  type: CloneType;
  /** 1.0 for exact/structural; Jaccard similarity for near */
  similarity: number;
  instances: CloneInstance[];
  /** Number of lines in the smallest instance of the cloned block */
  lineCount: number;
}

export interface DuplicateDetectionResult {
  cloneGroups: CloneGroup[];
  stats: {
    /** Functions analyzed (above minimum size threshold) */
    totalFunctions: number;
    /** Functions that appear in at least one clone group */
    duplicatedFunctions: number;
    /** duplicatedFunctions / totalFunctions */
    duplicationRatio: number;
    /** Number of distinct clone groups */
    cloneGroupCount: number;
  };
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Minimum function size (in lines) to consider for duplicate detection */
const MIN_LINES = 5;

/** Minimum number of normalized tokens to consider */
const MIN_TOKENS = 10;

/** Jaccard similarity threshold for near-clones */
const NEAR_THRESHOLD = 0.7;

/** N-gram size for shingle computation */
const SHINGLE_SIZE = 5;

/** Skip O(n²) near-clone pass when more than this many candidate functions */
const MAX_NEAR_FUNCTIONS = 400;

// ============================================================================
// KEYWORD SET (Type 2 normalization — preserve keywords, replace identifiers)
// Covers TypeScript, JavaScript, Python, Go, Rust, Ruby, Java, Swift.
// ============================================================================

const KEYWORDS = new Set([
  // Control flow
  'if', 'else', 'elif', 'for', 'while', 'do', 'break', 'continue', 'return',
  'switch', 'case', 'default', 'goto', 'fallthrough', 'pass',
  // Error handling
  'try', 'catch', 'finally', 'throw', 'raise', 'rescue', 'ensure',
  // Declarations
  'function', 'func', 'fn', 'def', 'class', 'struct', 'enum', 'interface',
  'module', 'type', 'impl', 'trait',
  // Variable declaration
  'const', 'let', 'var', 'val', 'mut', 'ref', 'move',
  // Modifiers
  'public', 'private', 'protected', 'static', 'abstract', 'final', 'readonly',
  'async', 'await', 'yield', 'override', 'virtual', 'synchronized',
  'pub', 'unsafe', 'extern', 'transient', 'volatile', 'native',
  // OOP
  'new', 'delete', 'this', 'self', 'Self', 'super', 'extends', 'implements',
  // Import/export
  'import', 'export', 'from', 'use', 'require', 'include', 'package', 'mod',
  // Logic
  'in', 'is', 'as', 'not', 'and', 'or', 'typeof', 'instanceof', 'void',
  // Context
  'with', 'match', 'when', 'where', 'select', 'defer', 'go', 'chan',
  // Literals
  'true', 'false', 'null', 'nil', 'None', 'True', 'False', 'undefined',
  // Python extras
  'lambda', 'del', 'global', 'nonlocal', 'assert', 'unless', 'until', 'begin',
  'end', 'then', 'do', 'defined',
  // Java extras
  'throws', 'instanceof',
  // Swift extras
  'guard', 'defer', 'repeat', 'fallthrough', 'inout', 'typealias', 'associatedtype',
  'fileprivate', 'open', 'indirect', 'lazy', 'weak', 'unowned', 'convenience',
  'required', 'override', 'prefix', 'postfix', 'infix', 'operator', 'precedencegroup',
  'some', 'any', 'actor', 'nonisolated', 'isolated', 'async', 'throws', 'rethrows',
  'Protocol', 'Type', 'init', 'deinit', 'subscript', 'willSet', 'didSet', 'get', 'set',
  // C++ extras
  'nullptr', 'constexpr', 'consteval', 'constinit', 'inline', 'extern',
  'friend', 'mutable', 'explicit', 'noexcept', 'typename', 'operator',
  'virtual', 'template', 'namespace', 'typedef', 'decltype', 'alignof',
  // Common builtins (high frequency, preserve to avoid false matches)
  'len', 'make', 'append', 'cap', 'copy', 'map', 'range',
]);

// ============================================================================
// NORMALIZATION
// ============================================================================

function stripComments(text: string): string {
  // // single-line (JS/TS/Go/Rust/Java)
  text = text.replace(/\/\/[^\n]*/g, '');
  // # single-line (Python/Ruby)
  text = text.replace(/#[^\n]*/g, '');
  // /* */ multi-line
  text = text.replace(/\/\*[\s\S]*?\*\//g, '');
  // Python """ and ''' docstrings
  text = text.replace(/"""[\s\S]*?"""/g, '');
  text = text.replace(/'''[\s\S]*?'''/g, '');
  return text;
}

/** Type 1: strip comments + collapse whitespace */
function normalizeType1(text: string): string {
  return stripComments(text).replace(/\s+/g, ' ').trim();
}

/**
 * Type 2: Type 1 + replace non-keyword identifiers with sequential placeholders.
 * Same identifier name → same placeholder within the function scope.
 */
function normalizeType2(text: string): string {
  const base = normalizeType1(text);
  const seen = new Map<string, string>();
  let counter = 0;
  return base.replace(/\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g, (match) => {
    if (KEYWORDS.has(match)) return match;
    if (!seen.has(match)) seen.set(match, `_v${counter++}`);
    return seen.get(match)!;
  });
}

function sha16(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// ============================================================================
// NEAR-CLONE (TYPE 3) — Jaccard on token n-grams
// ============================================================================

function tokenize(normalizedText: string): string[] {
  return normalizedText.match(/\S+/g) ?? [];
}

function getShingles(tokens: string[], k = SHINGLE_SIZE): Set<string> {
  const s = new Set<string>();
  for (let i = 0; i <= tokens.length - k; i++) {
    s.add(tokens.slice(i, i + k).join('\x00'));
  }
  return s;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ============================================================================
// LINE NUMBER HELPERS
// ============================================================================

/** Compute 1-based line number of a byte offset in source text */
function byteOffsetToLine(content: string, byteOffset: number): number {
  // Count newlines before the offset
  let line = 1;
  const end = Math.min(byteOffset, content.length);
  for (let i = 0; i < end; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * Detect duplicate functions across the codebase using the call graph's
 * function nodes (which carry byte-range boundaries) and the original file
 * contents.
 */
export function detectDuplicates(
  files: Array<{ path: string; content: string }>,
  callGraph: CallGraphResult,
): DuplicateDetectionResult {
  const fileContentMap = new Map(files.map(f => [f.path, f.content]));

  // ---- Step 1: Extract + normalize each function body ----
  interface Entry {
    instance: CloneInstance;
    t1Hash: string;
    t2Hash: string;
    shingles: Set<string>;
  }

  const entries: Entry[] = [];

  for (const node of callGraph.nodes.values()) {
    const content = fileContentMap.get(node.filePath);
    if (!content) continue;

    // Compute line numbers from byte offsets
    const startLine = byteOffsetToLine(content, node.startIndex);
    const endLine = byteOffsetToLine(content, node.endIndex);
    const lineCount = endLine - startLine + 1;

    if (lineCount < MIN_LINES) continue;

    const body = content.slice(node.startIndex, node.endIndex);
    const t1 = normalizeType1(body);
    const t2 = normalizeType2(body);
    const tokens = tokenize(t2);

    if (tokens.length < MIN_TOKENS) continue;

    entries.push({
      instance: {
        file: node.filePath,
        functionName: node.name,
        className: node.className,
        startLine,
        endLine,
      },
      t1Hash: sha16(t1),
      t2Hash: sha16(t2),
      shingles: getShingles(tokens),
    });
  }

  const cloneGroups: CloneGroup[] = [];
  const alreadyGrouped = new Set<number>(); // entry indices

  // ---- Step 2: Type 1 + Type 2 groups via hash bucketing ---- O(n)
  const t1Map = new Map<string, number[]>();
  const t2Map = new Map<string, number[]>();

  for (let i = 0; i < entries.length; i++) {
    const { t1Hash, t2Hash } = entries[i];
    (t1Map.get(t1Hash) ?? t1Map.set(t1Hash, []).get(t1Hash)!).push(i);
    (t2Map.get(t2Hash) ?? t2Map.set(t2Hash, []).get(t2Hash)!).push(i);
  }

  // Exact clones (Type 1)
  for (const indices of t1Map.values()) {
    if (indices.length < 2) continue;
    for (const i of indices) alreadyGrouped.add(i);
    const repIdx = indices[0];
    cloneGroups.push({
      type: 'exact',
      similarity: 1.0,
      instances: indices.map(i => entries[i].instance),
      lineCount: entries[repIdx].instance.endLine - entries[repIdx].instance.startLine + 1,
    });
  }

  // Structural clones (Type 2) — exclude those already in an exact group
  for (const indices of t2Map.values()) {
    if (indices.length < 2) continue;
    // Keep only entries not already in a Type 1 group
    const novel = indices.filter(i => {
      const t1Size = t1Map.get(entries[i].t1Hash)?.length ?? 0;
      return t1Size < 2;
    });
    if (novel.length < 2) continue;
    for (const i of novel) alreadyGrouped.add(i);
    const repIdx = novel[0];
    cloneGroups.push({
      type: 'structural',
      similarity: 1.0,
      instances: novel.map(i => entries[i].instance),
      lineCount: entries[repIdx].instance.endLine - entries[repIdx].instance.startLine + 1,
    });
  }

  // ---- Step 3: Near-clones (Type 3) — pairwise Jaccard — O(n²) bounded ----
  const ungrouped = entries
    .map((e, i) => ({ ...e, origIdx: i }))
    .filter(e => !alreadyGrouped.has(e.origIdx));

  if (ungrouped.length >= 2 && ungrouped.length <= MAX_NEAR_FUNCTIONS) {
    const nearGrouped = new Set<number>(); // indices into `ungrouped`

    for (let i = 0; i < ungrouped.length; i++) {
      if (nearGrouped.has(i)) continue;
      const group: number[] = [i];

      for (let j = i + 1; j < ungrouped.length; j++) {
        if (nearGrouped.has(j)) continue;
        const sim = jaccard(ungrouped[i].shingles, ungrouped[j].shingles);
        if (sim >= NEAR_THRESHOLD) {
          group.push(j);
          nearGrouped.add(j);
        }
      }

      if (group.length >= 2) {
        nearGrouped.add(i);
        // Use minimum pairwise similarity as the group's score (conservative)
        let minSim = 1.0;
        for (let k = 1; k < group.length; k++) {
          minSim = Math.min(minSim, jaccard(ungrouped[i].shingles, ungrouped[group[k]].shingles));
        }
        const repIdx = group[0];
        cloneGroups.push({
          type: 'near',
          similarity: Math.round(minSim * 100) / 100,
          instances: group.map(k => ungrouped[k].instance),
          lineCount:
            ungrouped[repIdx].instance.endLine - ungrouped[repIdx].instance.startLine + 1,
        });
      }
    }
  }

  // Sort by impact: (duplicated lines × copies) descending
  cloneGroups.sort(
    (a, b) => b.instances.length * b.lineCount - a.instances.length * a.lineCount
  );

  // ---- Stats ----
  const duplicatedSet = new Set<string>();
  for (const g of cloneGroups) {
    for (const inst of g.instances) {
      duplicatedSet.add(`${inst.file}:${inst.functionName}:${inst.startLine}`);
    }
  }

  return {
    cloneGroups,
    stats: {
      totalFunctions: entries.length,
      duplicatedFunctions: duplicatedSet.size,
      duplicationRatio:
        entries.length > 0
          ? Math.round((duplicatedSet.size / entries.length) * 1000) / 1000
          : 0,
      cloneGroupCount: cloneGroups.length,
    },
  };
}

// ============================================================================
// ONE-VS-ALL CLONE QUERY
// ============================================================================
//
// `detectDuplicates` answers the whole-repo audit question (every clone group),
// and its near-clone (Type 3) pass is O(n²) so it is skipped above
// MAX_NEAR_FUNCTIONS. `findClones` answers the edit-time question — "what
// existing functions are clones of THIS one body?" — by comparing a single
// query against every indexed function. That is O(n), so it computes near
// clones of the query even on repos where the whole-repo pass declines to run.
//
// It reuses the exact same normalization, shingling, Jaccard, and evidence
// thresholds as `detectDuplicates`: no new algorithm, clone type, or constant.

/** Evidence floor (lines) for a clone-query — same threshold as the whole-repo detector. */
export const CLONE_MIN_LINES = MIN_LINES;
/** Evidence floor (normalized tokens) for a clone-query — same threshold as the whole-repo detector. */
export const CLONE_MIN_TOKENS = MIN_TOKENS;
/** Default near-clone Jaccard floor — same threshold as the whole-repo detector. */
export const CLONE_NEAR_THRESHOLD = NEAR_THRESHOLD;

/** Hard lower bound on a caller-supplied near-clone similarity floor. */
const NEAR_FLOOR_MIN = 0.1;

/** The minimum node shape `findClones` needs — satisfied by both `FunctionNode` and its serialized form. */
export interface CloneQueryNode {
  filePath: string;
  name: string;
  className?: string;
  startIndex: number;
  endIndex: number;
  /** Source language of the node, surfaced on each match so cross-language matches are visible. */
  language?: string;
}

export interface CloneMatch {
  type: CloneType;
  /** 1.0 for exact/structural; rounded Jaccard for near. */
  similarity: number;
  file: string;
  functionName: string;
  className?: string;
  startLine: number;
  endLine: number;
  /**
   * The match's source language. Normalization is language-agnostic, so a `near` match CAN be in a
   * different language than the query (cross-language clones are out of scope — see the tool docs);
   * surfacing the language makes that disclosed limitation actionable rather than implied by the path.
   */
  language?: string;
}

export interface CloneQueryOptions {
  /** Near-clone Jaccard floor for this query (default CLONE_NEAR_THRESHOLD, clamped to [0.1, 1]). */
  minSimilarity?: number;
  /** Cap on returned matches (default: unlimited). */
  limit?: number;
  /**
   * Exclude the query's own instance (symbol mode), identified by its file + byte range. The byte
   * range (not the name) is the identity: it is unique per file and collision-proof, so the query is
   * never wrongly matched against itself and a different function is never wrongly excluded.
   */
  exclude?: { filePath: string; startIndex: number; endIndex: number };
}

export interface CloneQueryResult {
  matches: CloneMatch[];
  /** Query was below the evidence floor (too few lines/tokens) — no comparison performed. */
  belowThreshold: boolean;
  /** Number of indexed functions actually compared against (above their own evidence floor). */
  comparedAgainst: number;
  /** The near-clone similarity floor used (after clamping). */
  similarityFloor: number;
}

const CLONE_TYPE_RANK: Record<CloneType, number> = { exact: 0, structural: 1, near: 2 };

/**
 * Find the existing functions that are clones of a single query body.
 *
 * @param queryBody       raw source of the query (a function body, or a snippet)
 * @param queryLineCount  line span of the query (for the evidence floor)
 * @param files           source contents keyed by the same paths the nodes use
 * @param nodes           indexed functions to compare against (Map values or serialized array)
 */
export function findClones(
  queryBody: string,
  queryLineCount: number,
  files: Array<{ path: string; content: string }>,
  nodes: Iterable<CloneQueryNode>,
  options: CloneQueryOptions = {},
): CloneQueryResult {
  // NaN-safe: `??` only catches null/undefined, so a non-finite minSimilarity (e.g. a CLI
  // `--min foo` → parseFloat → NaN, or Infinity) would otherwise propagate to a NaN floor that
  // silently drops every near match and serializes as `null`. Coerce non-finite to the default.
  const requestedFloor = Number.isFinite(options.minSimilarity as number)
    ? (options.minSimilarity as number)
    : NEAR_THRESHOLD;
  const floor = Math.min(1, Math.max(NEAR_FLOOR_MIN, requestedFloor));

  // ---- Fingerprint the query ----
  const qT1 = normalizeType1(queryBody);
  const qT2 = normalizeType2(queryBody);
  const qTokens = tokenize(qT2);
  if (queryLineCount < MIN_LINES || qTokens.length < MIN_TOKENS) {
    return { matches: [], belowThreshold: true, comparedAgainst: 0, similarityFloor: floor };
  }
  const qT1Hash = sha16(qT1);
  const qT2Hash = sha16(qT2);
  const qShingles = getShingles(qTokens);

  const fileContentMap = new Map(files.map(f => [f.path, f.content]));
  const matches: CloneMatch[] = [];
  let comparedAgainst = 0;

  for (const node of nodes) {
    const content = fileContentMap.get(node.filePath);
    if (!content) continue;

    // Skip the query's own instance (symbol mode) before any work or counting. Identity is the
    // file + byte range (collision-proof), never the name.
    if (
      options.exclude &&
      node.filePath === options.exclude.filePath &&
      node.startIndex === options.exclude.startIndex &&
      node.endIndex === options.exclude.endIndex
    ) {
      continue;
    }

    const startLine = byteOffsetToLine(content, node.startIndex);
    const endLine = byteOffsetToLine(content, node.endIndex);
    if (endLine - startLine + 1 < MIN_LINES) continue;

    const body = content.slice(node.startIndex, node.endIndex);
    const tokens = tokenize(normalizeType2(body));
    if (tokens.length < MIN_TOKENS) continue;

    comparedAgainst++;

    const base = {
      file: node.filePath,
      functionName: node.name,
      className: node.className,
      startLine,
      endLine,
      language: node.language,
    };

    if (sha16(normalizeType1(body)) === qT1Hash) {
      matches.push({ type: 'exact', similarity: 1.0, ...base });
    } else if (sha16(normalizeType2(body)) === qT2Hash) {
      matches.push({ type: 'structural', similarity: 1.0, ...base });
    } else {
      const sim = jaccard(qShingles, getShingles(tokens));
      if (sim >= floor) {
        matches.push({ type: 'near', similarity: Math.round(sim * 100) / 100, ...base });
      }
    }
  }

  // Fully deterministic order: exact → structural → near, similarity desc, then a tie-break that
  // disambiguates every distinct match — file, startLine, endLine, then function name — so two
  // functions can never collide on the sort key (which would otherwise leave the final order at the
  // mercy of input iteration order). Byte-identical across re-evaluations of a fixed query/index.
  const cmpStr = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  matches.sort(
    (a, b) =>
      CLONE_TYPE_RANK[a.type] - CLONE_TYPE_RANK[b.type] ||
      b.similarity - a.similarity ||
      cmpStr(a.file, b.file) ||
      a.startLine - b.startLine ||
      a.endLine - b.endLine ||
      cmpStr(a.functionName, b.functionName),
  );

  const limited = options.limit && options.limit > 0 ? matches.slice(0, options.limit) : matches;
  return { matches: limited, belowThreshold: false, comparedAgainst, similarityFloor: floor };
}
