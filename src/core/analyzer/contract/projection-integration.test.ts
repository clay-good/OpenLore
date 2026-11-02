/**
 * The contract projection through the real CallGraphBuilder (change: add-contract-node-projection).
 *
 * Drives a build over an Express handler file, a client file, and the specification that declares
 * the operation, asserting the end-to-end result an agent sees: an OpenAPI node in the graph, an
 * `implements_endpoint` edge from the handler, a `consumes_endpoint` edge from the caller, and —
 * the invariant that keeps a declaration from being read as code — unchanged fan-in/fan-out and
 * no contract node among the hubs, entry points, or structural averages.
 */
import { describe, it, expect } from 'vitest';
import { CallGraphBuilder } from '../call-graph.js';

const SPEC = `openapi: 3.0.0
info: { title: orders, version: '1' }
servers:
  - url: /v1
paths:
  /orders/{id}:
    get:
      operationId: getOrder
      responses: { '200': { description: ok } }
  /orders:
    post:
      responses: { '201': { description: created } }
`;

const HANDLERS = `import express from 'express';
export const app = express();
export function getOrder(req, res) { return res.json({}); }
app.get('/v1/orders/:id', getOrder);
`;

const CLIENT = `export async function loadOrder(id) {
  const r = await fetch(\`/v1/orders/\${id}\`);
  return r.json();
}
`;

async function build(contract = SPEC) {
  const builder = new CallGraphBuilder({ contractFiles: [{ path: 'openapi.yaml', content: contract }] });
  return builder.build([
    { path: 'src/handlers.ts', content: HANDLERS, language: 'TypeScript' },
    { path: 'src/client.ts', content: CLIENT, language: 'TypeScript' },
  ]);
}

describe('contract projection through the builder', () => {
  it('puts the declared operation in the graph and binds the handler and the caller', async () => {
    const result = await build();
    const operations = [...result.nodes.values()].filter(n => n.language === 'OpenAPI');
    expect(operations.map(n => n.name).sort()).toEqual(['GET /v1/orders/{id}', 'POST /v1/orders']);

    const implementsEdge = result.edges.find(e => e.kind === 'implements_endpoint');
    expect(implementsEdge).toBeDefined();
    expect(result.nodes.get(implementsEdge!.callerId)?.name).toBe('getOrder');
    expect(result.nodes.get(implementsEdge!.calleeId)?.name).toBe('GET /v1/orders/{id}');

    const consumesEdge = result.edges.find(e => e.kind === 'consumes_endpoint');
    expect(consumesEdge).toBeDefined();
    expect(result.nodes.get(consumesEdge!.callerId)?.name).toBe('loadOrder');
    expect(result.nodes.get(consumesEdge!.calleeId)?.name).toBe('GET /v1/orders/{id}');
  });

  it('leaves fan-in, fan-out, hubs, entry points, and the averages untouched', async () => {
    const withContract = await build();
    const bare = await new CallGraphBuilder().build([
      { path: 'src/handlers.ts', content: HANDLERS, language: 'TypeScript' },
      { path: 'src/client.ts', content: CLIENT, language: 'TypeScript' },
    ]);
    const metrics = (r: Awaited<ReturnType<typeof build>>) =>
      [...r.nodes.values()]
        .filter(n => n.language !== 'OpenAPI')
        .map(n => `${n.id} ${n.fanIn}/${n.fanOut}`)
        .sort();
    expect(metrics(withContract)).toEqual(metrics(bare));
    expect(withContract.hubFunctions.some(n => n.language === 'OpenAPI')).toBe(false);
    expect(withContract.entryPoints.some(n => n.language === 'OpenAPI')).toBe(false);
    expect(withContract.stats.avgFanIn).toBe(bare.stats.avgFanIn);
    expect(withContract.stats.avgFanOut).toBe(bare.stats.avgFanOut);
  });

  it('discloses the operation no route serves', async () => {
    const result = await build();
    expect(result.contracts?.unmatchedOperations.items).toEqual(['POST /v1/orders (openapi.yaml:11)']);
  });

  it('discloses a specification that cannot be read instead of reporting no operations', async () => {
    const result = await build('openapi: 3.0.0\npaths:\n  - [\n');
    expect([...result.nodes.values()].some(n => n.language === 'OpenAPI')).toBe(false);
    expect(result.contracts?.unreadSpecifications.items[0]?.file).toBe('openapi.yaml');
  });

  it('projects nothing when the build is given no specification', async () => {
    const result = await new CallGraphBuilder().build([
      { path: 'src/handlers.ts', content: HANDLERS, language: 'TypeScript' },
    ]);
    expect(result.contracts).toBeUndefined();
    expect(result.edges.some(e => e.kind === 'implements_endpoint')).toBe(false);
  });
});

// A generated client's URL is built from a base variable, so path matching binds nothing and the
// operation reads as consumed by no one. Its method name is the `operationId`
// (change: add-contract-graph-projection).
describe('generated clients bound by operationId', () => {
  const GEN_SPEC = `openapi: 3.0.0
info: { title: orders, version: '1' }
servers:
  - url: /v1
paths:
  /orders/{id}:
    get:
      operationId: getOrder
      responses: { '200': { description: ok } }
`;
  const GENERATED = `/** @generated from openapi.yaml - do not edit */
const BASE = '/v1';
export function getOrder(id) { return fetch(\`\${BASE}/orders/\${id}\`); }
`;
  const HANDWRITTEN = `export function getOrder(id) { return { id }; }\n`;

  it('binds the generated method and leaves a same-named hand-written function alone', async () => {
    const builder = new CallGraphBuilder({ contractFiles: [{ path: 'openapi.yaml', content: GEN_SPEC }] });
    const result = await builder.build([
      { path: 'src/generated/client.ts', content: GENERATED, language: 'TypeScript' },
      { path: 'src/handwritten.ts', content: HANDWRITTEN, language: 'TypeScript' },
    ]);

    const consumes = result.edges.filter(e => e.kind === 'consumes_endpoint');
    expect(consumes).toHaveLength(1);
    expect(consumes[0].callerId).toBe('src/generated/client.ts::getOrder');
    expect(result.nodes.get(consumes[0].calleeId)?.name).toBe('GET /v1/orders/{id}');
  });

  it('binds nothing when no module claims the specification as its source', async () => {
    const builder = new CallGraphBuilder({ contractFiles: [{ path: 'openapi.yaml', content: GEN_SPEC }] });
    const result = await builder.build([
      { path: 'src/handwritten.ts', content: HANDWRITTEN, language: 'TypeScript' },
    ]);

    expect(result.edges.filter(e => e.kind === 'consumes_endpoint')).toHaveLength(0);
  });

  it('refuses to pick between two generated modules declaring the same operationId', async () => {
    const builder = new CallGraphBuilder({ contractFiles: [{ path: 'openapi.yaml', content: GEN_SPEC }] });
    const result = await builder.build([
      { path: 'src/gen/a.ts', content: GENERATED, language: 'TypeScript' },
      { path: 'src/gen/b.ts', content: GENERATED, language: 'TypeScript' },
    ]);

    expect(result.edges.filter(e => e.kind === 'consumes_endpoint')).toHaveLength(0);
    const disclosed = result.contracts?.unresolvedGeneratedBindings;
    expect(disclosed?.total).toBe(1);
    expect(disclosed?.items[0]).toMatchObject({ operationId: 'getOrder', reason: 'ambiguous-function' });
  });

  // Each case below produced a WRONG edge before review. A wrong edge is worse than a missing
  // one, so each gets a test.
  it('never binds to a second specification whose base name is a substring of the named one', async () => {
    const stripe = `openapi: 3.0.0
info: { title: stripe, version: '1' }
servers:
  - url: /v1
paths:
  /charges:
    get:
      operationId: getOrder
      responses: { '200': { description: ok } }
`;
    const builder = new CallGraphBuilder({
      contractFiles: [
        { path: 'api/openapi.yaml', content: GEN_SPEC },
        { path: 'third-party/stripe/openapi.yaml', content: stripe },
      ],
    });
    const result = await builder.build([
      { path: 'src/generated/client.ts', content: '/** @generated from api/openapi.yaml - do not edit */\nexport function getOrder(id) { return fetch(`/v1/orders/${id}`); }\n', language: 'TypeScript' },
    ]);

    const consumes = result.edges.filter(e => e.kind === 'consumes_endpoint');
    const targets = consumes.map(e => result.nodes.get(e.calleeId)?.filePath);
    expect(targets).not.toContain('third-party/stripe/openapi.yaml');
  });

  it('does not bind a hand-written module that merely mentions the specification', async () => {
    const builder = new CallGraphBuilder({ contractFiles: [{ path: 'openapi.yaml', content: GEN_SPEC }] });
    const result = await builder.build([
      { path: 'src/orders.ts', content: '// Order helpers.\n// See openapi.yaml for the wire contract these mirror.\nexport function getOrder(id) { return { id }; }\n', language: 'TypeScript' },
    ]);

    expect(result.edges.filter(e => e.kind === 'consumes_endpoint')).toHaveLength(0);
  });

  it('does not bind a test module even when its header claims generation', async () => {
    const builder = new CallGraphBuilder({ contractFiles: [{ path: 'openapi.yaml', content: GEN_SPEC }] });
    const result = await builder.build([
      { path: 'src/orders.test.ts', content: '// Fixtures generated from openapi.yaml\nexport function getOrder() { return [1]; }\n', language: 'TypeScript' },
    ]);

    expect(result.edges.filter(e => e.kind === 'consumes_endpoint')).toHaveLength(0);
  });

  it('clears the unmatched-operations disclosure it exists to fix', async () => {
    const builder = new CallGraphBuilder({ contractFiles: [{ path: 'openapi.yaml', content: GEN_SPEC }] });
    const result = await builder.build([
      { path: 'src/generated/client.ts', content: GENERATED, language: 'TypeScript' },
    ]);

    expect(result.edges.filter(e => e.kind === 'consumes_endpoint')).toHaveLength(1);
    // Bound by a generated client IS consumed; reporting it unmatched contradicted the edge.
    expect(result.contracts?.unmatchedOperations.items ?? []).toEqual([]);
  });

  it('marks the binding provenance so a reader does not read it as a stale index', async () => {
    const builder = new CallGraphBuilder({ contractFiles: [{ path: 'openapi.yaml', content: GEN_SPEC }] });
    const result = await builder.build([
      { path: 'src/generated/client.ts', content: GENERATED, language: 'TypeScript' },
    ]);

    expect(result.edges.find(e => e.kind === 'consumes_endpoint')?.synthesizedBy).toBe('operationId');
  });

  it('does not count a declaration binding toward a code function degree', async () => {
    const bare = await new CallGraphBuilder().build([
      { path: 'src/generated/client.ts', content: GENERATED, language: 'TypeScript' },
    ]);
    const withSpec = new CallGraphBuilder({ contractFiles: [{ path: 'openapi.yaml', content: GEN_SPEC }] });
    const bound = await withSpec.build([
      { path: 'src/generated/client.ts', content: GENERATED, language: 'TypeScript' },
    ]);

    const degree = (r: typeof bare) => [...r.nodes.values()]
      .filter(n => n.language === 'TypeScript')
      .map(n => `${n.name}:${n.fanIn}/${n.fanOut}`).sort();
    expect(degree(bound)).toEqual(degree(bare));
    expect(bound.entryPoints.map(n => n.name)).toContain('getOrder');
  });
});
