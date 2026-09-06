/**
 * Standing certification registry for derived-artifact acceleration paths.
 *
 * The registry is deliberately finite and reviewable. Adding an acceleration means adding a
 * row here and an executable assertion to the `test:equivalence` suite. Equivalence is evaluated
 * over the semantic answer projection; operational evidence such as cache state and repair status
 * remains in the served response and is asserted separately.
 *
 * change: certify-derived-artifact-equivalence
 */

export const SEMANTIC_ANSWER_PROJECTION = 'semantic-answer-v1' as const;

export type EquivalenceRowId =
  | 'cold-warm-context'
  | 'memo-hit-miss'
  | 'parallel-serial-extraction'
  | 'precomputed-live-traversal'
  | 'incremental-full-repair'
  | 'imported-local-structural'
  | 'bm25-cached-uncached'
  | 'function-vector-repair'
  | 'spec-vector-repair';

export type RecoveryMode = 'rebuild' | 'fallback' | 'fail-closed-then-repair';

export interface EquivalenceRow {
  id: EquivalenceRowId;
  artifact: string;
  authoritativeInputs: readonly string[];
  acceleratedPath: string;
  authoritativePath: string;
  assertion: string;
  recovery: RecoveryMode;
  fixtures: readonly string[];
  queryFixture: string | null;
  workerCounts: { accelerated: number; authoritative: number } | null;
  cacheModes: { accelerated: string; authoritative: string } | null;
  ciTests: readonly string[];
}

const COMMON_INPUTS = [
  'repository-snapshot:normalized-paths-and-bytes',
  'reachable-git-history',
  'normalized-analysis-configuration',
  'registered-analyzer-capabilities',
] as const;

/** Every registered acceleration row must be green before the certification gate passes. */
export const DERIVED_ARTIFACT_EQUIVALENCE_MATRIX: readonly EquivalenceRow[] = [
  {
    id: 'cold-warm-context',
    artifact: 'analysis generation and in-process context cache',
    authoritativeInputs: COMMON_INPUTS,
    acceleratedPath: 'warm readCachedContext result',
    authoritativePath: 'cold generation-verified context read',
    assertion: SEMANTIC_ANSWER_PROJECTION,
    recovery: 'fallback',
    fixtures: ['two-symbol-typescript-search-index'],
    queryFixture: 'authenticate session token',
    workerCounts: null,
    cacheModes: { accelerated: 'warm-process-cache', authoritative: 'cold-process-cache' },
    ciTests: ['src/core/analyzer/derived-artifact-equivalence.test.ts'],
  },
  {
    id: 'memo-hit-miss',
    artifact: 'Pass-1 extracted-fact memo',
    authoritativeInputs: COMMON_INPUTS,
    acceleratedPath: 'content-hash and extractor-stamp memo hit',
    authoritativePath: 'OPENLORE_NO_FACT_CACHE full extraction',
    assertion: SEMANTIC_ANSWER_PROJECTION,
    recovery: 'rebuild',
    fixtures: ['pass1-typescript-module-corpus'],
    queryFixture: null,
    workerCounts: null,
    cacheModes: { accelerated: 'memo-hit', authoritative: 'memo-disabled' },
    ciTests: [
      'src/core/analyzer/pass1-fact-cache.test.ts',
      'src/core/analyzer/hash-keyed-analyze.test.ts',
    ],
  },
  {
    id: 'parallel-serial-extraction',
    artifact: 'parallel extraction pool',
    authoritativeInputs: COMMON_INPUTS,
    acceleratedPath: 'worker-pool extraction',
    authoritativePath: 'single-worker extraction',
    assertion: SEMANTIC_ANSWER_PROJECTION,
    recovery: 'fallback',
    fixtures: ['sixteen-file-typescript-worker-corpus', 'native-grammar-worker-corpus'],
    queryFixture: null,
    workerCounts: { accelerated: 2, authoritative: 1 },
    cacheModes: null,
    ciTests: [
      'src/core/analyzer/extraction-pool.test.ts',
      'src/core/analyzer/extraction-pool-threads.test.ts',
    ],
  },
  {
    id: 'precomputed-live-traversal',
    artifact: 'reachability condensation precompute',
    authoritativeInputs: COMMON_INPUTS,
    acceleratedPath: 'persisted condensation traversal',
    authoritativePath: 'live graph traversal',
    assertion: SEMANTIC_ANSWER_PROJECTION,
    recovery: 'fallback',
    fixtures: ['cyclic-and-disconnected-traversal-graphs'],
    queryFixture: 'registered traversal seed, direction, filter, and depth cases',
    workerCounts: null,
    cacheModes: { accelerated: 'persisted-precompute', authoritative: 'live-traversal' },
    ciTests: [
      'src/core/analyzer/condensation.test.ts',
      'src/core/services/mcp-handlers/traversal.test.ts',
    ],
  },
  {
    id: 'incremental-full-repair',
    artifact: 'incremental watcher publication',
    authoritativeInputs: COMMON_INPUTS,
    acceleratedPath: 'watcher update after its repair barrier',
    authoritativePath: 'full analyze of the post-change state',
    assertion: SEMANTIC_ANSWER_PROJECTION,
    recovery: 'fail-closed-then-repair',
    fixtures: ['watcher-edit-add-delete-rename-corpus'],
    queryFixture: 'registered post-repair structural queries',
    workerCounts: null,
    cacheModes: { accelerated: 'incremental-after-repair', authoritative: 'full-rebuild' },
    ciTests: [
      'src/core/services/mcp-watcher-parity.test.ts',
      'src/core/services/mcp-watcher-incremental.test.ts',
    ],
  },
  {
    id: 'imported-local-structural',
    artifact: 'trusted structural graph bundle',
    authoritativeInputs: COMMON_INPUTS,
    acceleratedPath: 'trusted, current materialized bundle structural handlers',
    authoritativePath: 'local analysis at the same source commit',
    assertion: SEMANTIC_ANSWER_PROJECTION,
    recovery: 'fail-closed-then-repair',
    fixtures: ['signed-current-structural-bundle'],
    queryFixture: 'registered structural handler queries',
    workerCounts: null,
    cacheModes: { accelerated: 'trusted-bundle', authoritative: 'local-analysis' },
    ciTests: ['src/core/analyzer/index-bundle.test.ts'],
  },
  {
    id: 'bm25-cached-uncached',
    artifact: 'BM25 keyword corpus sidecar',
    authoritativeInputs: COMMON_INPUTS,
    acceleratedPath: 'validated persisted BM25 corpus',
    authoritativePath: 'BM25 corpus rebuilt from indexed records',
    assertion: SEMANTIC_ANSWER_PROJECTION,
    recovery: 'rebuild',
    fixtures: ['bm25-function-record-corpus'],
    queryFixture: 'connect',
    workerCounts: null,
    cacheModes: { accelerated: 'persisted-sidecar', authoritative: 'rebuilt-corpus' },
    ciTests: ['src/core/analyzer/bm25-corpus-persistence.test.ts'],
  },
  {
    id: 'function-vector-repair',
    artifact: 'function dense-vector table and metadata',
    authoritativeInputs: COMMON_INPUTS,
    acceleratedPath: 'healthy function vector table',
    authoritativePath: 'table rebuilt from registered structural records and embedder capability',
    assertion: SEMANTIC_ANSWER_PROJECTION,
    recovery: 'fail-closed-then-repair',
    fixtures: ['function-vector-record-corpus'],
    queryFixture: 'authenticate',
    workerCounts: null,
    cacheModes: { accelerated: 'validated-persisted-table', authoritative: 'full-vector-rebuild' },
    ciTests: ['src/core/analyzer/vector-index.test.ts'],
  },
  {
    id: 'spec-vector-repair',
    artifact: 'spec dense-vector table and metadata',
    authoritativeInputs: COMMON_INPUTS,
    acceleratedPath: 'healthy spec vector table',
    authoritativePath: 'table rebuilt from confined authoritative specs and registered embedder capability',
    assertion: SEMANTIC_ANSWER_PROJECTION,
    recovery: 'fail-closed-then-repair',
    fixtures: ['spec-vector-record-corpus'],
    queryFixture: 'email validation',
    workerCounts: null,
    cacheModes: { accelerated: 'validated-persisted-table', authoritative: 'full-vector-rebuild' },
    ciTests: ['src/core/analyzer/spec-vector-index.test.ts'],
  },
] as const;

/** Exact response paths excluded from semantic equality and asserted through row-specific tests. */
export const OPERATIONAL_ANSWER_PATHS = new Set([
  '$.cached',
  '$.cacheState',
  '$.freshness',
  '$.freshnessLease',
  '$.generatedAt',
  '$.generationId',
  '$.repair',
  '$.repairStatus',
  '$.servedAt',
  '$.timing',
]);

function canonicalize(value: unknown, path = '$'): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, `${path}[]`));
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const childPath = `${path}.${key}`;
    if (OPERATIONAL_ANSWER_PATHS.has(childPath)) continue;
    result[key] = canonicalize((value as Record<string, unknown>)[key], childPath);
  }
  return result;
}

/** Stable bytes for the conclusion fields whose equality the matrix certifies. */
export function semanticAnswerBytes(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * The first semantic difference between two answers, as a JSON path plus both values — or
 * `undefined` when they are equal.
 *
 * A byte comparison of two canonicalized answers proves equality but says nothing useful when it
 * fails: the message is two truncated JSON strings that differ somewhere. That is what left the
 * bundle round-trip's Windows divergence undiagnosed through several passes. Equality is still
 * decided by the same canonical form, so this narrows the report without widening what counts as
 * equal.
 */
export function firstSemanticDifference(actual: unknown, expected: unknown): string | undefined {
  const walk = (a: unknown, b: unknown, path: string): string | undefined => {
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b)) return `${path}: ${describe(a)} vs ${describe(b)}`;
      if (a.length !== b.length) return `${path}.length: ${a.length} vs ${b.length}`;
      for (let i = 0; i < a.length; i++) {
        const found = walk(a[i], b[i], `${path}[${i}]`);
        if (found) return found;
      }
      return undefined;
    }
    const aObj = !!a && typeof a === 'object';
    const bObj = !!b && typeof b === 'object';
    if (aObj !== bObj) return `${path}: ${describe(a)} vs ${describe(b)}`;
    // Scalar equality is the CANONICAL FORM's, not `Object.is`: the byte comparison encodes
    // through `JSON.stringify`, which calls `0` and `-0` equal, so `Object.is` would report a
    // difference the equality check two lines below does not — contradicting this function's
    // own promise that it only narrows the report.
    if (!aObj) {
      return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
        ? undefined
        : `${path}: ${describe(a)} vs ${describe(b)}`;
    }
    const keys = [...new Set([
      ...Object.keys(a as Record<string, unknown>),
      ...Object.keys(b as Record<string, unknown>),
    ])].sort();
    for (const key of keys) {
      const found = walk(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        `${path}.${key}`,
      );
      if (found) return found;
    }
    return undefined;
  };
  return walk(canonicalize(actual), canonicalize(expected), '$');
}

function describe(value: unknown): string {
  if (value === undefined) return '<absent>';
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}
