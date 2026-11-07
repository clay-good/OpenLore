/**
 * Per-format contract projection CONFORMANCE sweep (change: add-contract-node-projection).
 *
 * The `contractSchemas` capability is claimed for every member of `CONTRACT_LANGUAGES`. This
 * drives the real projector against a minimal realistic specification for each one and asserts
 * the projection genuinely fires — an operation becomes a node tagged with that format, AND the
 * edge kinds that format binds are produced (protobuf binds the server side only: a gRPC client
 * call is a disclosed boundary, so it produces no `consumes_endpoint`). A coverage guard fails if `CONTRACT_LANGUAGES` grows without a
 * fixture, so the matrix can never silently over-claim (the sibling of
 * `iac/iac-projection-conformance.test.ts`).
 */
import { describe, it, expect } from 'vitest';
import { projectContracts } from './project.js';
import { CONTRACT_LANGUAGES } from './types.js';
import type { FunctionNode } from '../call-graph-types.js';

interface FormatCase {
  /** The specification, and the method + path one route serves and one client calls. */
  spec: string;
  file: string;
  method: string;
  path: string;
  /** The edge kinds the format must produce. */
  kinds: string[];
}

const CASES: Record<string, FormatCase> = {
  OpenAPI: {
    file: 'openapi.yaml',
    method: 'GET',
    path: '/v1/orders/:id',
    spec: `openapi: 3.0.0
info: { title: orders, version: '1' }
servers:
  - url: /v1
paths:
  /orders/{id}:
    get:
      operationId: getOrder
      responses: { '200': { description: ok } }
`,
    kinds: ['implements_endpoint', 'consumes_endpoint'],
  },
  Protobuf: {
    file: 'proto/orders.proto',
    method: 'GET',
    path: '/unused',
    spec: `syntax = "proto3";
package orders.v1;
message GetOrderRequest { string id = 1; }
message Order { string id = 1; }
service OrderService { rpc GetOrder(GetOrderRequest) returns (Order); }
`,
    kinds: ['implements_endpoint', 'references_schema'],
  },
  GraphQL: {
    file: 'schema.graphql',
    method: 'GET',
    path: '/unused',
    spec: `type Order { id: ID! }
type Query { order(id: ID!): Order }
`,
    kinds: ['implements_endpoint', 'references_schema'],
  },
};

const code = (id: string): FunctionNode => ({
  id, name: id.slice(id.indexOf('::') + 2), filePath: id.slice(0, id.indexOf('::')),
  isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 0,
  startLine: 1, endLine: 5,
});

describe('contract projection conformance', () => {
  it('every CONTRACT_LANGUAGES member has a specification fixture wired (guard cannot rot)', () => {
    for (const lang of CONTRACT_LANGUAGES) {
      expect(CASES[lang], `no specification fixture wired for CONTRACT_LANGUAGES member ${lang}`).toBeDefined();
    }
  });

  for (const lang of CONTRACT_LANGUAGES) {
    it(`${lang}: projects an operation node and both edge kinds`, () => {
      const c = CASES[lang];
      const projection = projectContracts({
        files: [{ path: c.file, content: c.spec }],
        routes: [{
          file: 'src/routes.ts', method: c.method, path: c.path, normalizedPath: c.path,
          handlerName: 'handler', framework: 'express', line: 1, contractSource: 'none',
        }],
        calls: [{
          file: 'src/client.ts', method: c.method, url: c.path.replace(/:(\w+)/g, '${$1}'),
          normalizedUrl: c.path, line: 2, offset: 0, client: 'fetch',
        }],
        resolveHandler: () => code('src/routes.ts::handler'),
        resolveCaller: () => code('src/client.ts::load'),
        grpcRegistrations: [{ file: 'src/server.go', line: 3, runtime: 'go', service: 'OrderService', implType: 'server' }],
        resolveGrpcImplementation: () => [{ ...code('src/server.go::server.GetOrder'), name: 'GetOrder', className: 'server', language: 'Go' }],
        graphqlResolverMaps: () => [{ file: 'src/resolvers.ts', line: 1, runtime: 'node', root: 'Query', entries: [{ field: 'order', fn: 'getOrder', line: 2 }] }],
        resolveGraphqlImplementation: () => [code('src/resolvers.ts::getOrder')],
      });
      expect(projection.nodes.map(n => n.language)).toContain(lang);
      expect(new Set(projection.edges.filter(e => projection.nodes.find(n => n.id === e.calleeId)?.language === lang).map(e => e.kind)))
        .toEqual(new Set(c.kinds));
    });
  }
});
