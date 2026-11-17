/**
 * Contract node projection (change: add-contract-node-projection).
 *
 * Drives the real projector over the spec's scenarios and over every refusal it is required to
 * make rather than guess: an ambiguous address, a call to a foreign host, a binding whose code
 * node could not be pinned, an input that was not assessed, and each cap.
 */
import { describe, it, expect } from 'vitest';
import {
  projectContracts, contractDisclosure, MAX_CONTRACT_FILES, MAX_DISCLOSED,
  type ContractProjectionInput,
} from './project.js';
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

const yaml = (paths: string, servers = ''): string =>
  `openapi: 3.0.0\ninfo: { title: t, version: '1' }\n${servers}paths:\n${paths}`;
const op = (path: string, method = 'get', extra = ''): string =>
  `  ${path}:\n    ${method}:\n${extra}      responses: { '200': { description: ok } }\n`;

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
    // No className: it would group every operation of a file under a fake `OpenAPI` class and
    // collide with a real class of that name.
    expect(p.nodes[1].className).toBeUndefined();
  });

  it('binds a handler to its declared operation (scenario: a handler is bound)', () => {
    const p = projectContracts(input({ routes: [route()] }));
    const edge = p.edges.find(e => e.kind === 'implements_endpoint');
    expect(edge).toBeDefined();
    expect(edge!.callerId).toBe('src/handlers.ts::getOrder');
    expect(edge!.calleeName).toBe('GET /v1/orders/{id}');
    expect(p.unmatchedRoutes.items).toEqual([]);
    expect(p.unmatchedOperations.items).toEqual(['DELETE /v1/orders/{id} (openapi.yaml:15)']);
  });

  it('does not bind a similar but different route (scenario: similar routes)', () => {
    const p = projectContracts(input({ routes: [route({ path: '/v1/order/:id' })] }));
    expect(p.edges).toEqual([]);
    expect(p.unmatchedRoutes.items).toEqual([{ file: 'src/routes.ts', method: 'GET', path: '/v1/order/:id' }]);
    expect(p.unmatchedOperations.total).toBe(2);
  });

  it('binds a router mounted without the servers base path', () => {
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
    expect(p.unmatchedRoutes.total).toBe(1);
    expect(p.ambiguousAddresses.items).toEqual([
      { address: 'GET /orders/:param', operations: ['GET /v1/orders/{id}', 'GET /v2/orders/{id}'] },
    ]);
  });

  it('refuses an all-parameter base-less match', () => {
    const p = projectContracts(input({
      files: [{ path: 'openapi.yaml', content: yaml(op('/{id}'), 'servers:\n  - url: /v1\n') }],
      routes: [route({ path: '/:id' })],
    }));
    expect(p.edges).toEqual([]);
  });

  it('refuses two different operations that collapse to one normalized address', () => {
    // OpenAPI paths are case-sensitive and `/orders` differs from `/orders/`; the normalized key
    // cannot tell them apart, so neither binds and the ambiguity is named.
    const p = projectContracts(input({
      files: [{ path: 'openapi.yaml', content: yaml(op('/Orders') + op('/orders')) }],
      routes: [route({ path: '/orders' })],
    }));
    expect(p.edges).toEqual([]);
    expect(p.ambiguousAddresses.items[0].operations).toEqual(['GET /Orders', 'GET /orders']);
    expect(p.unmatchedRoutes.total).toBe(1);
  });

  it('treats the same address in two specifications as one operation (a bundle beside its source)', () => {
    const p = projectContracts(input({
      files: [{ path: 'a.yaml', content: SPEC }, { path: 'b.yaml', content: SPEC }],
      routes: [route()],
    }));
    expect(p.edges).toHaveLength(1);
    expect(p.edges[0].calleeId).toBe('a.yaml::GET /v1/orders/{id}');
    expect(p.ambiguousAddresses.total).toBe(0);
  });

  it('leaves a wildcard-method registration out of the match entirely', () => {
    const p = projectContracts(input({ routes: [route({ method: 'ALL' })] }));
    expect(p.edges).toEqual([]);
    expect(p.unmatchedRoutes.items).toEqual([]);
  });

  it('discloses a route whose handler matched an operation but could not be resolved', () => {
    const p = projectContracts(input({ routes: [route()], resolveHandler: () => undefined }));
    expect(p.edges).toEqual([]);
    expect(p.unmatchedRoutes.items).toEqual([]);
    expect(p.unresolvedBindings.items).toEqual([{
      file: 'src/routes.ts', line: 7, method: 'GET', path: '/v1/orders/:id',
      operation: 'GET /v1/orders/{id}',
    }]);
  });

  it('discloses a call whose caller matched an operation but could not be resolved', () => {
    const p = projectContracts(input({ calls: [call()], resolveCaller: () => undefined }));
    expect(p.edges).toEqual([]);
    expect(p.unresolvedBindings.items[0].operation).toBe('GET /v1/orders/{id}');
    expect(p.unboundClientCalls.items).toEqual([]);
  });

  it('binds a client call to an operation with no handler in the repository (scenario: external API)', () => {
    const p = projectContracts(input({
      files: [{ path: 'vendor/stripe.yaml', content: yaml(op('/v1/charges', 'post')) }],
      calls: [call({ method: 'POST', url: '/v1/charges' })],
    }));
    const edge = p.edges.find(e => e.kind === 'consumes_endpoint');
    expect(edge).toBeDefined();
    expect(edge!.callerId).toBe('src/client.ts::load');
    expect(edge!.calleeName).toBe('POST /v1/charges');
    expect(p.unmatchedOperations.items).toEqual([]);
  });

  it('binds a client call whose path parameter is interpolated', () => {
    const p = projectContracts(input({ calls: [call()] }));
    expect(p.edges.map(e => e.kind)).toEqual(['consumes_endpoint']);
  });

  it('discloses a call whose base is interpolated rather than binding it', () => {
    const p = projectContracts(input({ calls: [call({ url: '${base}/orders/1' })] }));
    expect(p.edges).toEqual([]);
    expect(p.unboundClientCalls.items).toEqual([
      { file: 'src/client.ts', line: 3, url: '${base}/orders/1', reason: 'path-not-literal' },
    ]);
    expect(p.unboundClientCalls.total).toBe(1);
  });

  it('discloses a call whose method is not literal', () => {
    const p = projectContracts(input({ calls: [call({ method: 'UNKNOWN' })] }));
    expect(p.unboundClientCalls.items[0].reason).toBe('method-not-literal');
  });

  it('discloses a call no operation declares', () => {
    const p = projectContracts(input({ calls: [call({ url: '/v1/customers' })] }));
    expect(p.unboundClientCalls.items[0].reason).toBe('no-operation');
  });

  it('binds an absolute client URL whose host the specification declares', () => {
    const p = projectContracts(input({ calls: [call({ url: 'https://api.example.com/v1/orders/7' })] }));
    expect(p.edges.map(e => e.kind)).toEqual(['consumes_endpoint']);
    expect(p.edges[0].calleeName).toBe('GET /v1/orders/{id}');
  });

  it('refuses an absolute client URL whose host the specification does not declare', () => {
    const p = projectContracts(input({ calls: [call({ url: 'https://other-vendor.example.com/v1/orders/7' })] }));
    expect(p.edges).toEqual([]);
    expect(p.unboundClientCalls.items[0].reason).toBe('foreign-host');
  });

  it('binds an absolute client URL when the specification declares no host to check', () => {
    const p = projectContracts(input({
      files: [{ path: 'openapi.yaml', content: yaml(op('/v1/orders/{id}')) }],
      calls: [call({ url: 'https://anything.example.com/v1/orders/7' })],
    }));
    expect(p.edges.map(e => e.kind)).toEqual(['consumes_endpoint']);
  });

  it('discloses an absolute client URL whose host is interpolated', () => {
    const p = projectContracts(input({ calls: [call({ url: 'https://${host}/v1/orders/7' })] }));
    expect(p.edges).toEqual([]);
    expect(p.unboundClientCalls.items[0].reason).toBe('path-not-literal');
  });

  it('prefers the exactly-declared path over a template the same path could fill', () => {
    const p = projectContracts(input({
      files: [{ path: 'openapi.yaml', content: yaml(op('/orders/{id}') + op('/orders/summary')) }],
      calls: [call({ url: '/orders/summary' })],
    }));
    expect(p.edges[0].calleeName).toBe('GET /orders/summary');
  });

  it('fills a concrete path into a template declared without the base path', () => {
    const p = projectContracts(input({ calls: [call({ url: '/orders/7' })] }));
    expect(p.edges.map(e => e.kind)).toEqual(['consumes_endpoint']);
    expect(p.edges[0].calleeName).toBe('GET /v1/orders/{id}');
  });

  it('binds nothing when a concrete path fills two different declared templates', () => {
    const p = projectContracts(input({
      files: [{ path: 'openapi.yaml', content: yaml(op('/orders/{id}') + op('/{kind}/7')) }],
      calls: [call({ url: '/orders/7' })],
    }));
    expect(p.edges).toEqual([]);
    expect(p.unboundClientCalls.items[0].reason).toBe('ambiguous-operation');
  });

  it('discloses a specification that declares itself one and cannot be read (scenario: unreadable)', () => {
    const p = projectContracts(input({ files: [{ path: 'broken.yaml', content: 'openapi: 3.0.0\npaths:\n  - [\n' }] }));
    expect(p.nodes).toEqual([]);
    expect(p.unreadSpecifications.total).toBe(1);
    expect(p.unreadSpecifications.items[0].file).toBe('broken.yaml');
    expect(p.unreadSpecifications.items[0].reason).toBeTruthy();
  });

  it('withholds every unmatched conclusion while a specification is unread', () => {
    const p = projectContracts(input({
      files: [{ path: 'openapi.yaml', content: SPEC }, { path: 'broken.yaml', content: 'openapi: 3.0.0\npaths:\n  - [\n' }],
      routes: [route({ path: '/v1/unknown' })],
    }));
    expect(p.unmatchedOperations.items).toEqual([]);
    expect(p.unmatchedRoutes.items).toEqual([]);
    expect(p.notAssessed).toEqual(['1 specification(s) could not be read']);
  });

  it('withholds every unmatched conclusion when the route extraction was not assessed', () => {
    const p = projectContracts(input({
      extractionNotAssessed: ['the route and client-call extraction failed'],
    }));
    expect(p.unmatchedOperations.items).toEqual([]);
    expect(p.unmatchedOperations.total).toBe(0);
    expect(p.notAssessed).toEqual(['the route and client-call extraction failed']);
  });

  it('reads nothing and discloses nothing for a file that is not a specification', () => {
    const p = projectContracts(input({ files: [{ path: 'app.yaml', content: 'services:\n  api: {}\n' }] }));
    expect(p.nodes).toEqual([]);
    expect(p.unreadSpecifications.total).toBe(0);
    expect(contractDisclosure(p)).toBeUndefined();
  });

  it('discloses the file cap rather than reading past it', () => {
    const files = Array.from({ length: MAX_CONTRACT_FILES + 2 }, (_, i) => ({ path: `spec-${String(i).padStart(3, '0')}.yaml`, content: SPEC }));
    const p = projectContracts(input({ files }));
    expect(p.truncations).toEqual([{ reason: 'file-cap', cap: MAX_CONTRACT_FILES, seen: files.length }]);
    expect(new Set(p.nodes.map(n => n.filePath)).size).toBe(MAX_CONTRACT_FILES);
    // The cap means an unread candidate could declare what a route serves.
    expect(p.unmatchedOperations.items).toEqual([]);
  });

  it('discloses candidates the caller did not retain', () => {
    const p = projectContracts(input({ filesOmitted: 7 }));
    expect(p.truncations).toEqual([{ reason: 'file-cap', cap: MAX_CONTRACT_FILES, seen: 8 }]);
  });

  it('discloses the cap even when the caller retained nothing at all', () => {
    const p = projectContracts(input({ files: [], filesOmitted: 3 }));
    expect(p.nodes).toEqual([]);
    expect(p.truncations).toEqual([{ reason: 'file-cap', cap: MAX_CONTRACT_FILES, seen: 3 }]);
  });

  it('keeps both caps when both fire', () => {
    const many = Array.from({ length: 3 }, (_, i) => ({
      path: `spec-${i}.yaml`,
      content: yaml(Array.from({ length: 800 }, (_, j) => op(`/r${i}-${j}`)).join('')),
    }));
    const p = projectContracts(input({ files: many, filesOmitted: MAX_CONTRACT_FILES }));
    expect(p.truncations?.map(t => t.reason).sort()).toEqual(['file-cap', 'operation-cap']);
  });

  it('bounds every disclosure list and keeps the total exact', () => {
    const routes = Array.from({ length: MAX_DISCLOSED + 5 }, (_, i) => route({ path: `/v1/none-${i}`, line: i + 1 }));
    const p = projectContracts(input({ routes }));
    expect(p.unmatchedRoutes.items).toHaveLength(MAX_DISCLOSED);
    expect(p.unmatchedRoutes.total).toBe(MAX_DISCLOSED + 5);
  });

  it('is deterministic in node and edge order regardless of input order', () => {
    const files = [{ path: 'b.yaml', content: SPEC.replace('/v1', '/v2') }, { path: 'a.yaml', content: SPEC }];
    const routes = [route(), route({ file: 'src/other.ts', path: '/v2/orders/:id' })];
    const one = projectContracts(input({ files, routes }));
    const two = projectContracts(input({ files: [...files].reverse(), routes: [...routes].reverse() }));
    expect(one.nodes.map(n => n.id)).toEqual(two.nodes.map(n => n.id));
    expect(one.edges).toEqual(two.edges);
  });

  it('projects nothing when there are no candidate files', () => {
    const p = projectContracts(input({ files: [] }));
    expect(p.nodes).toEqual([]);
    expect(p.edges).toEqual([]);
    expect(contractDisclosure(p)).toBeUndefined();
  });
});
