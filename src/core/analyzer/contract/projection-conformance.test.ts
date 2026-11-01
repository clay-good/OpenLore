/**
 * Per-format contract projection CONFORMANCE sweep (change: add-contract-node-projection).
 *
 * The `contractSchemas` capability is claimed for every member of `CONTRACT_LANGUAGES`. This
 * drives the real projector against a minimal realistic specification for each one and asserts
 * the projection genuinely fires — an operation becomes a node tagged with that format, AND both
 * edge kinds are produced. A coverage guard fails if `CONTRACT_LANGUAGES` grows without a
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
      });
      expect(projection.nodes.map(n => n.language)).toContain(lang);
      expect(new Set(projection.edges.map(e => e.kind)))
        .toEqual(new Set(['implements_endpoint', 'consumes_endpoint']));
    });
  }
});
