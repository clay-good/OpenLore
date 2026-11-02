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

// Named schemas as nodes, with `$ref` edges (change: add-contract-schema-elements). A schema
// shared by twenty operations is ONE node with twenty inbound edges, which is what makes "what
// does changing `Order` touch?" answerable.
describe('named schemas in the graph', () => {
  const SCHEMA_SPEC = `openapi: 3.0.0
info: { title: orders, version: '1' }
servers:
  - url: /v1
paths:
  /orders:
    post:
      operationId: createOrder
      requestBody:
        content: { application/json: { schema: { $ref: '#/components/schemas/OrderInput' } } }
      responses:
        '201':
          description: created
          content: { application/json: { schema: { $ref: '#/components/schemas/Order' } } }
components:
  schemas:
    Order:
      type: object
      properties:
        id: { type: string }
        customer: { $ref: '#/components/schemas/Customer' }
    OrderInput: { type: object, properties: { sku: { type: string } } }
    Customer: { type: object, properties: { name: { type: string } } }
`;
  const HANDLER = `import express from 'express';
export const app = express();
export function createOrder(req, res) { return res.json({}); }
app.post('/orders', createOrder);
`;

  const build = () => new CallGraphBuilder({ contractFiles: [{ path: 'openapi.yaml', content: SCHEMA_SPEC }] })
    .build([{ path: 'src/orders.ts', content: HANDLER, language: 'TypeScript' }]);

  it('projects one node per named schema, with its declared line', async () => {
    const result = await build();

    const schemas = [...result.nodes.values()].filter(n => n.name.startsWith('#/components/schemas/'));
    expect(schemas.map(n => n.name).sort()).toEqual([
      '#/components/schemas/Customer',
      '#/components/schemas/Order',
      '#/components/schemas/OrderInput',
    ]);
    // The bare name is carried as the signature, and the line is the declaration's own.
    expect(schemas.find(n => n.name.endsWith('/Order'))?.signature).toBe('Order');
    expect(schemas.every(n => (n.startLine ?? 0) > 1)).toBe(true);
  });

  it('links an operation to the schemas it names, and a schema to the schemas it names', async () => {
    const result = await build();

    const refs = result.edges.filter(e => e.kind === 'references_schema')
      .map(e => `${result.nodes.get(e.callerId)?.name} -> ${result.nodes.get(e.calleeId)?.name}`)
      .sort();
    expect(refs).toEqual([
      'POST /v1/orders -> #/components/schemas/Order',
      'POST /v1/orders -> #/components/schemas/OrderInput',
      '#/components/schemas/Order -> #/components/schemas/Customer',
    ].sort());
  });

  it('leaves every code measurement untouched', async () => {
    const bare = await new CallGraphBuilder().build([{ path: 'src/orders.ts', content: HANDLER, language: 'TypeScript' }]);
    const withSchemas = await build();

    const degrees = (r: typeof bare) => [...r.nodes.values()]
      .filter(n => n.language === 'TypeScript')
      .map(n => `${n.name}:${n.fanIn}/${n.fanOut}`).sort();
    expect(degrees(withSchemas)).toEqual(degrees(bare));
    expect(withSchemas.stats.avgFanIn).toBe(bare.stats.avgFanIn);
    expect(withSchemas.stats.avgFanOut).toBe(bare.stats.avgFanOut);
    // A declaration is never an entry point or a hub of the code.
    for (const n of [...withSchemas.entryPoints, ...withSchemas.hubFunctions]) {
      expect(n.language).not.toBe('OpenAPI');
    }
  });

  it('discloses a `$ref` naming a schema the document does not declare instead of dropping it', async () => {
    // A ref to a name that is not under `components/schemas` — a typo, or a schema that moved.
    const dangling = SCHEMA_SPEC.replace(
      "{ $ref: '#/components/schemas/Customer' }",
      "{ $ref: '#/components/schemas/Missing' }",
    );
    const result = await new CallGraphBuilder({ contractFiles: [{ path: 'openapi.yaml', content: dangling }] })
      .build([{ path: 'src/orders.ts', content: HANDLER, language: 'TypeScript' }]);

    const names = [...result.nodes.values()].map(n => n.name);
    expect(names, 'nothing is invented for a name the document never declares').not.toContain('#/components/schemas/Missing');
    // No edge, and the gap is named rather than read as "Order references nothing".
    const from = result.edges.filter(e => e.kind === 'references_schema')
      .map(e => result.nodes.get(e.calleeId)?.name);
    expect(from).not.toContain('#/components/schemas/Missing');
    expect(result.contracts?.notAssessed?.join(' ') ?? '').toMatch(/does not declare|unresolved \$ref/);
  });

  it('survives a schema cycle without looping', async () => {
    const cyclic = `openapi: 3.0.0
info: { title: c, version: '1' }
paths:
  /a:
    get:
      responses:
        '200':
          description: ok
          content: { application/json: { schema: { $ref: '#/components/schemas/Node' } } }
components:
  schemas:
    Node:
      type: object
      properties:
        next: { $ref: '#/components/schemas/Node' }
        peer: { $ref: '#/components/schemas/Other' }
    Other: { type: object, properties: { back: { $ref: '#/components/schemas/Node' } } }
`;
    const result = await new CallGraphBuilder({ contractFiles: [{ path: 'openapi.yaml', content: cyclic }] }).build([]);

    const refs = result.edges.filter(e => e.kind === 'references_schema');
    // Self-reference and the two-way cycle are both edges, each drawn once.
    expect(refs.length).toBeGreaterThanOrEqual(3);
    expect(new Set(refs.map(e => `${e.callerId}->${e.calleeId}`)).size).toBe(refs.length);
  });
});
