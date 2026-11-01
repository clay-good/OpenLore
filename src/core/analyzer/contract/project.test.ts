/**
 * Contract node projection (change: add-contract-node-projection).
 *
 * Drives the real projector over the spec's scenarios: a handler bound to its declared
 * operation, a similar-but-different route left unbound, an external API consumed with no
 * handler in the repository, and every refusal disclosed rather than dropped.
 */
import { describe, it, expect } from 'vitest';
import { projectContracts, MAX_CONTRACT_FILES, type ContractProjectionInput } from './project.js';
import type { FunctionNode } from '../call-graph-types.js';
import type { HttpCall, RouteDefinition } from '../http-route-parser.js';

const SPEC = `openapi: 3.0.0
info: { title: t, version: '1' }
servers:
  - url: https://api.example.com/v1
paths:
  /orders/{id}:
    get:
      operationId: getOrder
      parameters:
        - name: id
          in: path
          required: true
          schema: { type: string }
      responses: { '200': { description: ok } }
    delete:
      responses: { '204': { description: gone } }
`;

function node(id: string, filePath: string, name: string): FunctionNode {
  return {
    id, name, filePath, isAsync: false, language: 'TypeScript',
    startIndex: 0, endIndex: 100, fanIn: 0, fanOut: 0, startLine: 1, endLine: 10,
  };
}

function route(partial: Partial<RouteDefinition> = {}): RouteDefinition {
  return {
    file: 'src/routes.ts', method: 'GET', path: '/v1/orders/:id',
    normalizedPath: '/v1/orders/:param', handlerName: 'getOrder', framework: 'express',
    line: 7, contractSource: 'none', ...partial,
  };
}

function call(partial: Partial<HttpCall> = {}): HttpCall {
  return {
    file: 'src/client.ts', method: 'GET', url: '/v1/orders/${id}',
    normalizedUrl: '/v1/orders/:param', line: 3, offset: 20, client: 'fetch', ...partial,
  };
}

function input(partial: Partial<ContractProjectionInput> = {}): ContractProjectionInput {
  const handler = node('src/handlers.ts::getOrder', 'src/handlers.ts', 'getOrder');
  return {
    files: [{ path: 'openapi.yaml', content: SPEC }],
    routes: [],
    calls: [],
    resolveHandler: () => handler,
    resolveCaller: () => node('src/client.ts::load', 'src/client.ts', 'load'),
    ...partial,
  };
}

describe('projectContracts', () => {
  it('projects each operation as an OpenAPI node addressed by method and full path', () => {
    const p = projectContracts(input());
    expect(p.nodes.map(n => n.name)).toEqual(['DELETE /v1/orders/{id}', 'GET /v1/orders/{id}']);
    expect(p.nodes.every(n => n.language === 'OpenAPI')).toBe(true);
    expect(p.nodes[1].filePath).toBe('openapi.yaml');
    expect(p.nodes[1].signature).toBe('getOrder');
    // Line of the method key, so the node points at the declaration.
    expect(p.nodes[1].startLine).toBeGreaterThan(1);
  });

  it('binds a handler to its declared operation (scenario: a handler is bound)', () => {
    const p = projectContracts(input({ routes: [route()] }));
    const edge = p.edges.find(e => e.kind === 'implements_endpoint');
    expect(edge).toBeDefined();
    expect(edge!.callerId).toBe('src/handlers.ts::getOrder');
    expect(edge!.calleeName).toBe('GET /v1/orders/{id}');
    expect(p.unmatchedRoutes).toEqual([]);
    expect(p.unmatchedOperations).toEqual(['DELETE /v1/orders/{id}']);
  });

  it('does not bind a similar but different route (scenario: similar routes)', () => {
    const p = projectContracts(input({ routes: [route({ path: '/v1/order/:id' })] }));
    expect(p.edges).toEqual([]);
    expect(p.unmatchedRoutes).toEqual([{ file: 'src/routes.ts', method: 'GET', path: '/v1/order/:id' }]);
    expect(p.unmatchedOperations).toEqual(['DELETE /v1/orders/{id}', 'GET /v1/orders/{id}']);
  });

  it('binds a router mounted without the servers base path, when the declared path is unique', () => {
    const p = projectContracts(input({ routes: [route({ path: '/orders/:id' })] }));
    expect(p.edges.map(e => e.kind)).toEqual(['implements_endpoint']);
  });

  it('refuses a base-less match when two specifications declare the same path', () => {
    const p = projectContracts(input({
      files: [
        { path: 'a.yaml', content: SPEC },
        { path: 'b.yaml', content: SPEC.replace('api.example.com/v1', 'api.example.com/v2') },
      ],
      routes: [route({ path: '/orders/:id' })],
    }));
    expect(p.edges).toEqual([]);
    expect(p.unmatchedRoutes).toHaveLength(1);
  });

  it('refuses an all-parameter base-less match', () => {
    const spec = `openapi: 3.0.0\ninfo: { title: t, version: '1' }\nservers:\n  - url: /v1\npaths:\n  /{id}:\n    get:\n      responses: { '200': { description: ok } }\n`;
    const p = projectContracts(input({ files: [{ path: 'openapi.yaml', content: spec }], routes: [route({ path: '/:id' })] }));
    expect(p.edges).toEqual([]);
  });

  it('leaves a wildcard-method registration out of the match entirely', () => {
    const p = projectContracts(input({ routes: [route({ method: 'ALL' })] }));
    expect(p.edges).toEqual([]);
    expect(p.unmatchedRoutes).toEqual([]);
  });

  it('keeps the operation matched when only the handler could not be resolved', () => {
    const p = projectContracts(input({ routes: [route()], resolveHandler: () => undefined }));
    expect(p.edges).toEqual([]);
    expect(p.unmatchedRoutes).toEqual([]);
    expect(p.unmatchedOperations).toEqual(['DELETE /v1/orders/{id}']);
  });

  it('binds a client call to an operation with no handler in the repository (scenario: external API)', () => {
    const vendored = `openapi: 3.0.0\ninfo: { title: t, version: '1' }\npaths:\n  /v1/charges:\n    post:\n      responses: { '200': { description: ok } }\n`;
    const p = projectContracts(input({
      files: [{ path: 'vendor/stripe.yaml', content: vendored }],
      calls: [call({ method: 'POST', url: '/v1/charges' })],
    }));
    const edge = p.edges.find(e => e.kind === 'consumes_endpoint');
    expect(edge).toBeDefined();
    expect(edge!.callerId).toBe('src/client.ts::load');
    expect(edge!.calleeName).toBe('POST /v1/charges');
    expect(p.unmatchedOperations).toEqual([]);
  });

  it('binds a client call whose path parameter is interpolated', () => {
    const p = projectContracts(input({ calls: [call()] }));
    expect(p.edges.map(e => e.kind)).toEqual(['consumes_endpoint']);
  });

  it('discloses a call whose base is interpolated rather than binding it', () => {
    const p = projectContracts(input({ calls: [call({ url: '${base}/orders/1' })] }));
    expect(p.edges).toEqual([]);
    expect(p.unboundClientCalls).toEqual([
      { file: 'src/client.ts', line: 3, url: '${base}/orders/1', reason: 'path-not-literal' },
    ]);
    expect(p.unboundClientCallCount).toBe(1);
  });

  it('discloses a call whose method is not literal', () => {
    const p = projectContracts(input({ calls: [call({ method: 'UNKNOWN' })] }));
    expect(p.unboundClientCalls[0].reason).toBe('method-not-literal');
  });

  it('discloses a call no operation declares', () => {
    const p = projectContracts(input({ calls: [call({ url: '/v1/customers' })] }));
    expect(p.unboundClientCalls[0].reason).toBe('no-operation');
  });

  it('binds an absolute client URL whose concrete value fills the declared parameter', () => {
    const p = projectContracts(input({ calls: [call({ url: 'https://api.example.com/v1/orders/7' })] }));
    expect(p.edges.map(e => e.kind)).toEqual(['consumes_endpoint']);
    expect(p.edges[0].calleeName).toBe('GET /v1/orders/{id}');
  });

  it('prefers the exactly-declared path over a template the same path could fill', () => {
    const spec = `openapi: 3.0.0\ninfo: { title: t, version: '1' }\npaths:\n  /orders/{id}:\n    get:\n      responses: { '200': { description: ok } }\n  /orders/summary:\n    get:\n      operationId: summary\n      responses: { '200': { description: ok } }\n`;
    const p = projectContracts(input({ files: [{ path: 'openapi.yaml', content: spec }], calls: [call({ url: '/orders/summary' })] }));
    expect(p.edges[0].calleeName).toBe('GET /orders/summary');
  });

  it('binds nothing when a concrete path fills two different declared templates', () => {
    const spec = `openapi: 3.0.0\ninfo: { title: t, version: '1' }\npaths:\n  /orders/{id}:\n    get:\n      responses: { '200': { description: ok } }\n  /{kind}/7:\n    get:\n      responses: { '200': { description: ok } }\n`;
    const p = projectContracts(input({ files: [{ path: 'openapi.yaml', content: spec }], calls: [call({ url: '/orders/7' })] }));
    expect(p.edges).toEqual([]);
    expect(p.unboundClientCalls[0].reason).toBe('no-operation');
  });

  it('treats two specifications declaring the same path shape as one operation', () => {
    const spec = `openapi: 3.0.0\ninfo: { title: t, version: '1' }\npaths:\n  /orders/{id}:\n    get:\n      responses: { '200': { description: ok } }\n`;
    const p = projectContracts(input({
      files: [{ path: 'a.yaml', content: spec }, { path: 'b.yaml', content: spec.replace('{id}', '{code}') }],
      calls: [call({ url: '/orders/7' })],
    }));
    expect(p.edges).toHaveLength(1);
    expect(p.edges[0].calleeId).toBe('a.yaml::GET /orders/{id}');
  });

  it('discloses a specification that declares itself one and cannot be read (scenario: unreadable)', () => {
    const p = projectContracts(input({ files: [{ path: 'broken.yaml', content: 'openapi: 3.0.0\npaths:\n  - [\n' }] }));
    expect(p.nodes).toEqual([]);
    expect(p.unreadSpecifications).toHaveLength(1);
    expect(p.unreadSpecifications[0].file).toBe('broken.yaml');
    expect(p.unreadSpecifications[0].reason).toBeTruthy();
  });

  it('reads nothing and discloses nothing for a file that is not a specification', () => {
    const p = projectContracts(input({ files: [{ path: 'app.yaml', content: 'services:\n  api: {}\n' }] }));
    expect(p.nodes).toEqual([]);
    expect(p.unreadSpecifications).toEqual([]);
  });

  it('discloses the file cap rather than reading past it', () => {
    const files = Array.from({ length: MAX_CONTRACT_FILES + 2 }, (_, i) => ({ path: `spec-${String(i).padStart(3, '0')}.yaml`, content: SPEC }));
    const p = projectContracts(input({ files }));
    expect(p.truncated).toEqual({ reason: 'file-cap', cap: MAX_CONTRACT_FILES, seen: files.length });
    expect(new Set(p.nodes.map(n => n.filePath)).size).toBe(MAX_CONTRACT_FILES);
  });

  it('discloses candidates the caller did not retain', () => {
    const p = projectContracts(input({ filesOmitted: 7 }));
    expect(p.truncated).toEqual({ reason: 'file-cap', cap: MAX_CONTRACT_FILES, seen: 8 });
  });

  it('discloses the cap even when the caller retained nothing at all', () => {
    const p = projectContracts(input({ files: [], filesOmitted: 3 }));
    expect(p.nodes).toEqual([]);
    expect(p.truncated).toEqual({ reason: 'file-cap', cap: MAX_CONTRACT_FILES, seen: 3 });
  });

  it('is deterministic in node and edge order regardless of input order', () => {
    const files = [{ path: 'b.yaml', content: SPEC.replace('/v1', '/v2') }, { path: 'a.yaml', content: SPEC }];
    const one = projectContracts(input({ files, routes: [route(), route({ file: 'src/other.ts', path: '/v2/orders/:id' })] }));
    const two = projectContracts(input({ files: [...files].reverse(), routes: [route({ file: 'src/other.ts', path: '/v2/orders/:id' }), route()] }));
    expect(one.nodes.map(n => n.id)).toEqual(two.nodes.map(n => n.id));
    expect(one.edges).toEqual(two.edges);
  });

  it('projects nothing when there are no candidate files', () => {
    const p = projectContracts(input({ files: [] }));
    expect(p.nodes).toEqual([]);
    expect(p.edges).toEqual([]);
  });
});
