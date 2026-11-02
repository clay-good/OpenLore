/**
 * A projected declaration never competes with code for a ranked slot.
 *
 * An IaC resource, an OpenAPI operation and an OpenAPI schema are all indexed as graph nodes so
 * that a caller who NAMES their language can retrieve them, and so the contract surfaces can
 * bind them to handlers. None of them is source code, and every surface that ranks code has to
 * exclude them — otherwise one ordinary specification file, which can declare several hundred
 * named schemas, fills the whole result set and evicts every function the caller was looking
 * for. That is not a degraded ranking; it is a ranking with no code in it.
 *
 * These are the surfaces the invariant was NOT pinned on when schema projection shipped:
 * `search_code`, `suggest_insertion_points` and `orient` all share one candidate filter in the
 * index, so one missing exclusion took out all three at once (change:
 * add-contract-schema-elements).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorIndex, _resetVectorIndexCachesForTesting } from '../../analyzer/vector-index.js';
import type { FunctionNode } from '../../analyzer/call-graph.js';

function makeNode(o: Partial<FunctionNode>): FunctionNode {
  return {
    id: 'x', name: 'x', filePath: 'src/x.ts', language: 'TypeScript',
    isAsync: false, startIndex: 0, endIndex: 0, fanIn: 0, fanOut: 0, ...o,
  };
}

/** Two order-handling functions, and the sixteen schemas a small document declares about orders. */
const CODE: FunctionNode[] = [
  makeNode({
    id: 'src/orders.ts::createOrder', name: 'createOrder', filePath: 'src/orders.ts',
    signature: 'export function createOrder(input: OrderInput): Order', fanIn: 3, fanOut: 2,
  }),
  makeNode({
    id: 'src/orders.ts::cancelOrder', name: 'cancelOrder', filePath: 'src/orders.ts',
    signature: 'export function cancelOrder(id: string): Order', fanIn: 1, fanOut: 1,
  }),
];

const SCHEMAS: FunctionNode[] = Array.from({ length: 16 }, (_, i) =>
  makeNode({
    id: `openapi.yaml::#/components/schemas/Order${i}`,
    name: `#/components/schemas/Order${i}`,
    filePath: 'openapi.yaml',
    language: 'OpenAPI',
    signature: `Order${i}`,
  }),
);

const OPERATIONS: FunctionNode[] = [
  makeNode({
    id: 'openapi.yaml::POST /orders', name: 'POST /orders',
    filePath: 'openapi.yaml', language: 'OpenAPI', signature: 'createOrder',
  }),
];

describe('projected declarations never rank as code', () => {
  let projectDir: string;
  let outputDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'openlore-projected-rank-'));
    outputDir = join(projectDir, '.openlore', 'analysis');
    vi.stubEnv('EMBED_BASE_URL', '');
    vi.stubEnv('EMBED_MODEL', '');
    _resetVectorIndexCachesForTesting();
    await VectorIndex.build(outputDir, [...CODE, ...SCHEMAS, ...OPERATIONS], [], new Set(), new Set(), null);
    _resetVectorIndexCachesForTesting();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    _resetVectorIndexCachesForTesting();
  });

  it('search_code returns the functions, not the schemas that outnumber them', async () => {
    const { handleSearchCode } = await import('./semantic.js');
    const res = await handleSearchCode(projectDir, 'order', 10) as {
      results: Array<{ name: string; language: string }>;
    };

    expect(res.results.length).toBeGreaterThan(0);
    expect(res.results.map(r => r.language)).not.toContain('OpenAPI');
    expect(res.results.map(r => r.name)).toContain('createOrder');
  });

  it('search_code still serves a declaration when the caller names its language', async () => {
    const { handleSearchCode } = await import('./semantic.js');
    const res = await handleSearchCode(projectDir, 'order', 10, 'OpenAPI') as {
      results: Array<{ name: string; language: string }>;
    };

    // Excluded from the DEFAULT candidate set, not removed from the index: a caller asking for
    // the contract surface by name still gets it, which is what the contract tools rely on.
    expect(res.results.length).toBeGreaterThan(0);
    expect(new Set(res.results.map(r => r.language))).toEqual(new Set(['OpenAPI']));
  });

  it('suggest_insertion_points proposes code to edit, never a declaration', async () => {
    const { handleSuggestInsertionPoints } = await import('./semantic.js');
    const res = await handleSuggestInsertionPoints(projectDir, 'add an order cancellation rule', 5) as {
      candidates: Array<{ name: string; language: string }>;
    };

    expect(res.candidates.length).toBeGreaterThan(0);
    // An agent cannot insert a step into a JSON schema; recommending one is a wrong answer
    // delivered with the product's confidence behind it.
    expect(res.candidates.map(c => c.language)).not.toContain('OpenAPI');
  });

  it('orient briefs on the code in scope, not on the document that mentions it', async () => {
    const { handleOrient } = await import('./orient.js');
    const res = await handleOrient(projectDir, 'change how an order is created', 5) as {
      relevantFunctions: Array<{ name: string; language?: string }>;
      insertionPoints?: Array<{ name: string; language?: string }>;
    };

    expect(res.relevantFunctions.length).toBeGreaterThan(0);
    expect(res.relevantFunctions.map(f => f.language ?? '')).not.toContain('OpenAPI');
    for (const p of res.insertionPoints ?? []) expect(p.language ?? '').not.toBe('OpenAPI');
  });
});
