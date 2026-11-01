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
