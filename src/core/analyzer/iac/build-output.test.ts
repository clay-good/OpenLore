/**
 * Build-output mapping (change: add-iac-deploy-binding-commands), and the deploy bindings it
 * makes possible. A built handler path must reach its source through the project's OWN
 * declaration — and stay unresolved, with the reason, when the project declares none.
 */
import { describe, it, expect } from 'vitest';
import { readBuildOutputMap, sourceStems, isUnmappedBuildOutput } from './build-output.js';
import { bindDeployHandlers } from './deploy-binding.js';
import { extractServerless } from './serverless.js';
import type { FunctionNode } from '../call-graph-types.js';

const map = (files: Record<string, string>) => readBuildOutputMap(new Map(Object.entries(files)));

describe('readBuildOutputMap', () => {
  it('reads outDir and rootDir from tsconfig', () => {
    expect(map({ 'tsconfig.json': '{"compilerOptions":{"outDir":"./dist","rootDir":"./src"}}' }))
      .toEqual({ outDir: 'dist', rootDir: 'src' });
  });

  it('reads a tsconfig with comments and a trailing comma (it is JSONC)', () => {
    expect(map({ 'tsconfig.json': '{\n // the build\n "compilerOptions": { "outDir": "build", /* in */ "rootDir": "lib", },\n}' }))
      .toEqual({ outDir: 'build', rootDir: 'lib' });
  });

  it('keeps a path containing a double slash out of the comment stripper', () => {
    expect(map({ 'tsconfig.json': '{"compilerOptions":{"outDir":"dist","rootDir":"src"},"extends":"https://example.com/base.json"}' }))
      .toEqual({ outDir: 'dist', rootDir: 'src' });
  });

  it('reads a main/source pair from the package manifest', () => {
    expect(map({ 'package.json': '{"main":"dist/index.js","source":"src/index.ts"}' }))
      .toEqual({ mainToSource: { main: 'dist/index.js', source: 'src/index.ts' } });
  });

  it('contributes nothing from an absent, unreadable, or mapping-free config', () => {
    expect(map({})).toEqual({});
    expect(map({ 'tsconfig.json': 'not json at all {{' })).toEqual({});
    expect(map({ 'package.json': '{"main":"dist/index.js"}' })).toEqual({});
    expect(map({ 'tsconfig.json': '{"compilerOptions":{"outDir":"."}}' })).toEqual({});
  });
});

describe('sourceStems', () => {
  const m = { outDir: 'dist', rootDir: 'src' };
  it('keeps the path itself first, so a handler naming source is unaffected', () => {
    expect(sourceStems('src/orders.ts', m)).toEqual(['src/orders.ts']);
  });
  it('maps a path under outDir to the same path under rootDir', () => {
    expect(sourceStems('dist/api/orders', m)).toEqual(['dist/api/orders', 'src/api/orders']);
  });
  it('maps main to source, extension aside', () => {
    expect(sourceStems('dist/index.js', { mainToSource: { main: 'dist/index.js', source: 'src/index.ts' } }))
      .toEqual(['dist/index.js', 'src/index']);
  });
  it('maps nothing without a mapping, and nothing outside outDir', () => {
    expect(sourceStems('dist/orders', undefined)).toEqual(['dist/orders']);
    expect(sourceStems('other/orders', m)).toEqual(['other/orders']);
  });
});

describe('isUnmappedBuildOutput', () => {
  it('is true only under a declared outDir the project maps to no input', () => {
    expect(isUnmappedBuildOutput('dist/orders', { outDir: 'dist' })).toBe(true);
    expect(isUnmappedBuildOutput('dist/orders', { outDir: 'dist', rootDir: 'src' })).toBe(false);
    expect(isUnmappedBuildOutput('src/orders', { outDir: 'dist' })).toBe(false);
    expect(isUnmappedBuildOutput('dist/orders', undefined)).toBe(false);
  });
});

function code(file: string, name: string): FunctionNode {
  return {
    id: `${file}::${name}`, name, filePath: file, isAsync: false, language: 'TypeScript',
    startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 0, startLine: 1, endLine: 5,
  };
}

const SLS = `service: orders
provider:
  name: aws
  runtime: nodejs20.x
functions:
  createOrder:
    handler: dist/orders.create
`;

describe('a built handler through the deploy binder', () => {
  it('binds to the source the project maps it to', () => {
    const graph = extractServerless([{ path: 'serverless.yml', content: SLS, language: 'Serverless' }]);
    const bound = bindDeployHandlers(graph, [code('src/orders.ts', 'create')], { outDir: 'dist', rootDir: 'src' });
    expect(bound.edges).toEqual([{
      callerId: 'serverless.yml::serverless.yml::function.createOrder',
      calleeId: 'src/orders.ts::create',
      calleeName: 'create',
      line: 7,
      confidence: 'import',
      kind: 'deploys_symbol',
    }]);
    expect(bound.unresolved).toEqual([]);
  });

  it('stays unresolved, naming the missing mapping, when the project declares none', () => {
    const graph = extractServerless([{ path: 'serverless.yml', content: SLS, language: 'Serverless' }]);
    const bound = bindDeployHandlers(graph, [code('src/orders.ts', 'create')], { outDir: 'dist' });
    expect(bound.edges).toEqual([]);
    expect(bound.unresolved[0].reason).toMatch(/maps to no source/);
  });

  it('binds a Serverless handler that names source directly', () => {
    const graph = extractServerless([{ path: 'serverless.yml', content: SLS.replace('dist/orders.create', 'src/orders.create'), language: 'Serverless' }]);
    const bound = bindDeployHandlers(graph, [code('src/orders.ts', 'create')]);
    expect(bound.edges.map(e => e.calleeId)).toEqual(['src/orders.ts::create']);
  });

  it('binds a handler relative to a manifest in a subdirectory', () => {
    const graph = extractServerless([{ path: 'services/api/serverless.yml', content: SLS.replace('dist/orders.create', 'src/orders.create'), language: 'Serverless' }]);
    const bound = bindDeployHandlers(graph, [code('services/api/src/orders.ts', 'create')]);
    expect(bound.edges.map(e => e.calleeId)).toEqual(['services/api/src/orders.ts::create']);
  });

  it('discloses a Serverless function whose handler is a variable', () => {
    const graph = extractServerless([{ path: 'serverless.yml', content: 'service: s\nfunctions:\n  a:\n    handler: ${self:x}.h\n', language: 'Serverless' }]);
    const bound = bindDeployHandlers(graph, [code('src/a.ts', 'h')]);
    expect(bound.edges).toEqual([]);
    expect(bound.unresolved[0].reason).toMatch(/Serverless variable/);
  });
});
