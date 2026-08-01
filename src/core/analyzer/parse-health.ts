/**
 * Parse-health disclosure (change: add-parse-health-boundary-disclosure).
 *
 * The language-support registry can't over-claim a *language* — but it says nothing about failed
 * extraction *inside* a supported language. A file the pinned grammar rejects, a tree tree-sitter
 * recovered with a large `ERROR` region, or a source that decoded lossily today yields a silently
 * smaller graph indistinguishable from "there is genuinely nothing there." This module records
 * per-file parse health so downstream conclusions can disclose *unknown* instead of implying
 * *absent* — the exact failure mode the `NoFalseCompleteness` requirement exists to prevent.
 *
 * Two honesty rules, mirroring the style-fingerprint and IaC extractors:
 *   1. Clean files pay zero: `tallyParseHealth` returns `undefined` unless the parsed tree actually
 *      carries an error, so a healthy repo produces no records and no boundary is ever emitted.
 *   2. The signal is a LOWER BOUND: an ERROR region can swallow well-formed neighbors, so a
 *      disclosed count is "at least this degraded," never "exactly this and no more."
 *
 * Tallied in the SAME per-file AST walk that extracts nodes/edges (no second parse), exactly like
 * the style fingerprint. Deterministic: integer tallies over a deterministic walk, sorted keys, no
 * clock — byte-identical across re-analyses of a fixed repository state.
 */

import type { MemoryDegradation } from './memory-strategy.js';

/** Bump when the persisted artifact shape changes incompatibly. */
export const PARSE_HEALTH_SCHEMA_VERSION = 1;

/**
 * Cap on the number of error-region start lines retained per file. A bound on the persisted record
 * (a pathological file could otherwise carry thousands of ERROR nodes); the counts stay exact, only
 * the line LIST is truncated, and truncation is disclosed (`truncated: true`).
 */
export const PARSE_HEALTH_LINE_CAP = 25;


/**
 * Machine-readable cause for a file the analyzer declined to include (change:
 * fix-analyze-native-abort-and-file-cost-budget).
 *
 * Before this existed, an exclusion reached the user as a bare count — "Files skipped: 3" — with
 * no cause, while `doctor` judged the same repository independently and could report a clean bill
 * of health for it. Recording the cause on the file, in the one artifact every health surface
 * reads, is what makes the two surfaces unable to disagree.
 *
 * Each member is a path that actually exists in the code; the set is deliberately not aspirational:
 *  - `parse-failure`   the extractor threw, or produced no usable tree
 *  - `budget-exceeded` the parse hit {@link PER_FILE_PARSE_BUDGET_MS} and was abandoned
 *  - `size-cap`        the file exceeded a size bound before extraction was attempted
 *
 * A **worker fault is deliberately absent**. The proposal listed one, but a worker fault no longer
 * excludes a file: the pool hands the file back to the main thread — the reference implementation —
 * which extracts it normally, so the facts stay whole and the fault is disclosed on the extraction
 * LANE instead. If that main-thread attempt also fails, the reason recorded here is the one the
 * main thread actually produced. Recording `worker-fault` on the file would have blamed the source
 * for a defect in the thread reading it.
 *
 * `encoding` is likewise absent: a lossy decode does not exclude a file (it still parses, over
 * replacement characters), so it stays the separate `encodingFallback` signal it has always been.
 */
export type FileExclusionReason =
  | 'parse-failure'
  | 'budget-exceeded'
  | 'size-cap';

/**
 * Per-file parse health. Present ONLY for a file with at least one signal (error region, parse
 * failure, or encoding fallback) — a clean file has no record. Absent fields mean "not observed."
 */
export interface FileParseHealth {
  filePath: string;
  language: string;
  /** tree-sitter `ERROR` nodes (unparseable spans the recovery inserted). */
  errorCount: number;
  /** tree-sitter `MISSING` nodes (tokens the grammar expected but the source omitted). */
  missingCount: number;
  /** 1-based start lines of the error/missing regions, sorted + deduped, bounded by the cap. */
  errorLines: number[];
  /** `errorLines` hit the cap — more regions exist than are listed. */
  truncated?: boolean;
  /** The extractor threw or produced no usable tree — the whole file contributed nothing. */
  parseFailed?: boolean;
  /** The source decoded lossily (contained U+FFFD) — parse output may be garbage. */
  encodingFallback?: boolean;
  /**
   * Why this file contributed nothing, when it contributed nothing. Absent on a file that WAS
   * extracted and merely parsed with error regions — a degraded file is not an excluded one.
   */
  exclusion?: FileExclusionReason;
  /**
   * The budget, in ms, that this file exceeded. Present only for `budget-exceeded`.
   *
   * The BOUND, not the measured elapsed time — deliberately. This artifact must be byte-identical
   * across re-analyses of a fixed repository state (change: fix-artifact-output-determinism), and
   * a wall-clock measurement never is. Nothing is lost: a file is only recorded here because it
   * ran past the bound, so "exceeded 20000ms" says everything the measurement would, and says it
   * the same way every run. The measured time still reaches the operator live, on the CLI's
   * extraction-lane disclosure, which is not persisted.
   */
  budgetMs?: number;
}

/**
 * Minimal structural view of a tree-sitter node. Kept dependency-light (no `tree-sitter` import) so
 * this module stays a leaf, and defensive across binding versions: `ERROR` is detected by `type`
 * (stable across bindings) and `MISSING` by `isMissing` as either a boolean property (node-tree-
 * sitter) or a method (web-tree-sitter). A plain test object supplying only `type`/`children`
 * still works.
 */
export interface ParseHealthNode {
  type: string;
  startPosition: { row: number };
  isMissing?: boolean | (() => boolean);
  hasError?: boolean | (() => boolean);
  children: ParseHealthNode[];
  childCount?: number;
  child?(i: number): ParseHealthNode | null;
}

function coerceBool(v: boolean | (() => boolean) | undefined): boolean {
  return typeof v === 'function' ? !!v() : !!v;
}

/** Does the (sub)tree rooted here carry any error/missing node? Cheap: reads the root's own flag. */
function treeHasError(root: ParseHealthNode): boolean {
  // `hasError` on the ROOT reflects the whole tree in every binding we use. Fall back to a direct
  // ERROR-type check for a test object that omits the flag.
  if (root.hasError !== undefined) return coerceBool(root.hasError);
  return root.type === 'ERROR';
}

function isMissingNode(n: ParseHealthNode): boolean {
  return coerceBool(n.isMissing);
}

/**
 * Record parse health for one file from its already-parsed tree. Returns `undefined` for a clean
 * tree (the fast path — no walk, zero cost, so a healthy repo produces no records). When the tree
 * carries an error it walks ALL children (not just named — an unnamed ERROR token still counts),
 * tallying `ERROR` and `MISSING` nodes and collecting their start lines up to the cap.
 *
 * The walk fires only on the rare error tree, so its `children` allocation is not on the hot path.
 *
 * ## The walk is iterative, and that is load-bearing
 *
 * This walk used to recurse (change: fix-analyze-native-abort-and-file-cost-budget). Tree depth is
 * not bounded by anything the analyzer controls: a 300 KB file of a repeated unterminated
 * block-comment opener parses into a right-leaning chain 100,002 nodes deep, and error recovery is
 * exactly the condition that produces such trees — which is also exactly when this walk runs. The
 * recursion overflowed the stack there, and a `RangeError` raised while executing inside the
 * native binding's node accessor is what turns a slow file into
 * `libc++abi: terminating due to uncaught exception of type Napi::Error` and an exit-134 abort,
 * with no JavaScript error anywhere. An explicit stack costs a heap array and cannot overflow, so
 * depth stops being a correctness cliff. Order is unchanged: children are pushed in reverse so
 * they pop in source order, which keeps `errorLines` (capped by insertion order) byte-identical
 * to the recursive version.
 */
export function tallyParseHealth(
  language: string,
  rootNode: ParseHealthNode,
  filePath: string,
): FileParseHealth | undefined {
  if (!treeHasError(rootNode)) return undefined;

  let errorCount = 0;
  let missingCount = 0;
  const lines = new Set<number>();
  let truncated = false;

  const stack: ParseHealthNode[] = [rootNode];
  while (stack.length > 0) {
    const n = stack.pop()!;
    let isRegion = false;
    if (n.type === 'ERROR') { errorCount++; isRegion = true; }
    if (isMissingNode(n)) { missingCount++; isRegion = true; }
    if (isRegion) {
      if (lines.size < PARSE_HEALTH_LINE_CAP) lines.add(n.startPosition.row + 1);
      else truncated = true;
    }
    // Prefer allocation-free index accessors (real SyntaxNode); fall back to `.children` (tests).
    // Pushed in reverse so the first child is visited first — preserving the recursive order.
    if (typeof n.childCount === 'number' && typeof n.child === 'function') {
      for (let i = n.childCount - 1; i >= 0; i--) {
        const c = n.child(i);
        if (c) stack.push(c);
      }
    } else {
      const kids = n.children;
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  }

  // `hasError` can read true on a tree that carries no actual ERROR/MISSING node (a binding/grammar
  // quirk observed on some grammars for well-formed input). Parse health is a SOUND LOWER BOUND —
  // over-reporting would cry wolf on clean code — so a signal with no confirmed error node is
  // dropped, not fabricated.
  if (errorCount === 0 && missingCount === 0) return undefined;

  return {
    filePath,
    language,
    errorCount,
    missingCount,
    errorLines: [...lines].sort((a, b) => a - b),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * True if decoding these bytes as UTF-8 is LOSSY — the source contains byte sequences that are not
 * valid UTF-8 and would be replaced by U+FFFD. Detected at the BYTE level (a strict decode that
 * throws), NOT by scanning the decoded string for U+FFFD: a file may legitimately CONTAIN U+FFFD
 * (as valid UTF-8 bytes `EF BF BD`), and flagging that would be a false positive. Only genuinely
 * undecodable bytes count.
 */
export function isLossyUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

/** A file is "degraded" if it carries any parse-health signal at all. */
export function isDegraded(h: FileParseHealth): boolean {
  return h.errorCount > 0 || h.missingCount > 0 || !!h.parseFailed || !!h.encodingFallback
    || h.exclusion !== undefined;
}

/** Human phrasing for one exclusion reason, used by every surface that renders one. */
export const EXCLUSION_REASON_LABEL: Record<FileExclusionReason, string> = {
  'parse-failure': 'parse failed — contributed no symbols',
  'budget-exceeded': 'abandoned at the per-file parse budget',
  'size-cap': 'exceeded a size cap — not extracted',
};

/** One language's rolled-up degradation, for the compact summary. */
export interface ParseHealthLanguageSummary {
  language: string;
  degradedFiles: number;
  errorRegions: number;
  parseFailures: number;
  encodingFallbacks: number;
}

/** The persisted, rolled-up parse-health report (its own `parse-health.json` artifact). */
export interface ParseHealthReport {
  version: number;
  /** Files carrying at least one signal. */
  totalDegradedFiles: number;
  /** Sum of ERROR + MISSING regions across all degraded files. */
  totalErrorRegions: number;
  /** Per-language rollup, sorted by degraded-file count desc then name. */
  byLanguage: ParseHealthLanguageSummary[];
  /** The worst offenders, sorted by region count desc then path, bounded. */
  topFiles: FileParseHealth[];
  /** Every per-file record (the source of truth the watcher splices and consumers scan). */
  files: FileParseHealth[];
  /**
   * How many files were EXCLUDED, per reason (change:
   * fix-analyze-native-abort-and-file-cost-budget). Omitted entirely when nothing was excluded,
   * so a repository whose only signal is error regions carries no empty tally. This is the single
   * record every health surface reads, which is what stops `analyze` and `doctor` disagreeing.
   */
  excludedByReason?: Partial<Record<FileExclusionReason, number>>;
  /**
   * What the graceful-degradation ladder shed under memory pressure, if anything (change:
   * make-analyze-scale-to-any-repo). Present ONLY when a tier was shed — a full-fidelity run
   * carries none, so its artifact stays byte-identical to a run that never had this feature. Rides
   * the SAME artifact every health surface already reads, so a reduced overlay/deep-analysis is
   * disclosed exactly like an excluded file: a downstream conclusion reads it as reduced coverage,
   * never as genuine structural absence.
   */
  memoryDegradation?: MemoryDegradation;
}

/** Total files excluded (any reason). `0` when nothing was excluded. */
export function totalExcluded(report: ParseHealthReport | null | undefined): number {
  if (!report?.excludedByReason) return 0;
  return Object.values(report.excludedByReason).reduce((a, b) => a + (b ?? 0), 0);
}

/**
 * One-line "3 excluded (2 budget-exceeded, 1 parse-failure)" phrasing, or `undefined` when nothing
 * was excluded. Shared so `analyze`, `doctor` and the boundary text cannot word it differently.
 * Reason order is fixed (alphabetical) so the line is deterministic across runs.
 */
export function describeExclusions(report: ParseHealthReport | null | undefined): string | undefined {
  const total = totalExcluded(report);
  if (total === 0) return undefined;
  const parts = Object.entries(report!.excludedByReason!)
    .filter(([, n]) => (n ?? 0) > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([reason, n]) => `${n} ${reason}`);
  return `${total} file${total === 1 ? '' : 's'} excluded (${parts.join(', ')})`;
}

function regionCount(h: FileParseHealth): number {
  return h.errorCount + h.missingCount;
}

/**
 * Roll the raw per-file records up into the persisted report. Returns `undefined` when there are no
 * records at all — a clean repo persists no artifact and every consumer treats "no artifact" as
 * "nothing degraded," so clean repos pay zero (no boundary, no payload growth).
 */
export function buildParseHealthReport(
  records: FileParseHealth[],
  topN = 10,
  memoryDegradation?: MemoryDegradation,
): ParseHealthReport | undefined {
  const degraded = records.filter(isDegraded);
  // A memory-pressure degradation is a whole-analysis reduction with no per-file records of its
  // own, so it can be the ONLY signal — a large but cleanly-parsing repository sheds the overlay
  // yet has zero degraded files. Emit a minimal report carrying just the degradation so the
  // disclosure still reaches every consumer (change: make-analyze-scale-to-any-repo).
  if (degraded.length === 0) {
    if (!memoryDegradation) return undefined;
    return {
      version: PARSE_HEALTH_SCHEMA_VERSION,
      totalDegradedFiles: 0,
      totalErrorRegions: 0,
      byLanguage: [],
      topFiles: [],
      files: [],
      memoryDegradation,
    };
  }

  const byLang = new Map<string, ParseHealthLanguageSummary>();
  const excludedByReason: Partial<Record<FileExclusionReason, number>> = {};
  let totalErrorRegions = 0;
  for (const h of degraded) {
    if (h.exclusion) excludedByReason[h.exclusion] = (excludedByReason[h.exclusion] ?? 0) + 1;
    totalErrorRegions += regionCount(h);
    const s = byLang.get(h.language) ?? {
      language: h.language,
      degradedFiles: 0,
      errorRegions: 0,
      parseFailures: 0,
      encodingFallbacks: 0,
    };
    s.degradedFiles++;
    s.errorRegions += regionCount(h);
    if (h.parseFailed) s.parseFailures++;
    if (h.encodingFallback) s.encodingFallbacks++;
    byLang.set(h.language, s);
  }

  const byLanguage = [...byLang.values()].sort(
    (a, b) => b.degradedFiles - a.degradedFiles || (a.language < b.language ? -1 : 1),
  );
  const sorted = [...degraded].sort(
    (a, b) => regionCount(b) - regionCount(a) || (a.filePath < b.filePath ? -1 : 1),
  );

  return {
    version: PARSE_HEALTH_SCHEMA_VERSION,
    totalDegradedFiles: degraded.length,
    totalErrorRegions,
    byLanguage,
    topFiles: sorted.slice(0, topN),
    files: sorted,
    // Omitted when nothing was excluded, so a repo whose only signal is error regions carries no
    // empty tally and its artifact stays byte-identical to before this change.
    ...(Object.keys(excludedByReason).length > 0 ? { excludedByReason } : {}),
    // Present only under memory pressure; a full-fidelity run omits it and stays byte-identical.
    ...(memoryDegradation ? { memoryDegradation } : {}),
  };
}

/** A compact, one-line-per-language string list for the `orient` summary (bounded upstream). */
export function compactParseHealthSummary(report: ParseHealthReport): string[] {
  return report.byLanguage.map(
    (s) =>
      `${s.language}=${s.degradedFiles} file${s.degradedFiles === 1 ? '' : 's'}` +
      ` (${s.errorRegions} error region${s.errorRegions === 1 ? '' : 's'}` +
      `${s.parseFailures ? `, ${s.parseFailures} parse-failure${s.parseFailures === 1 ? '' : 's'}` : ''}` +
      `${s.encodingFallbacks ? `, ${s.encodingFallbacks} encoding-fallback${s.encodingFallbacks === 1 ? '' : 's'}` : ''})`,
  );
}
