/**
 * Build-output mapping (change: add-iac-deploy-binding-commands), and the deploy bindings it
 * makes possible. A built handler path must reach its source through the project's OWN
 * declaration — and stay unresolved, with the reason, when the project declares none.
 */
import { describe, it, expect } from 'vitest';
import { readBuildOutputMap, mappedSourceStems, isUnmappedBuildOutput } from './build-output.js';
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

  it('reads a tsconfig written with a byte-order mark', () => {
    expect(map({ 'tsconfig.json': '\ufeff{"compilerOptions":{"outDir":"dist","rootDir":"src"}}' }))
      .toEqual({ outDir: 'dist', rootDir: 'src' });
  });

  it('keeps a comma inside a quoted path, which a whole-text regex would delete', () => {
    expect(map({ 'package.json': '{"main":"dist/a, }b.js", // c\n "source":"src/a, }b.ts"}' }))
      .toEqual({ mainToSource: { main: 'dist/a, }b.js', source: 'src/a, }b.ts' } });
  });

  it('contributes nothing from an absent, unreadable, or mapping-free config', () => {
    expect(map({})).toEqual({});
    expect(map({ 'tsconfig.json': 'not json at all {{' })).toEqual({});
    expect(map({ 'package.json': '{"main":"dist/index.js"}' })).toEqual({});
    expect(map({ 'tsconfig.json': '{"compilerOptions":{"outDir":"."}}' })).toEqual({});
  });
});

describe('mappedSourceStems', () => {
  const m = { outDir: 'dist', rootDir: 'src' };
  it('returns only what the mapping says, not the path itself', () => {
    expect(mappedSourceStems('dist/api/orders', m)).toEqual(['src/api/orders']);
    expect(mappedSourceStems('src/orders.ts', m)).toEqual([]);
  });
  it('maps main to source, extension aside', () => {
    expect(mappedSourceStems('dist/index.js', { mainToSource: { main: 'dist/index.js', source: 'src/index.ts' } }))
      .toEqual(['src/index']);
  });
  it('maps nothing without a mapping, and nothing outside outDir', () => {
    expect(mappedSourceStems('dist/orders', undefined)).toEqual([]);
    expect(mappedSourceStems('other/orders', m)).toEqual([]);
  });
  it('maps nothing when the mapping points out of the repository', () => {
    expect(mappedSourceStems('dist/orders', { outDir: 'dist', rootDir: '../src' })).toEqual([]);
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

  it('stays unresolved, naming exactly what was looked at, when the root config maps nothing', () => {
    const graph = extractServerless([{ path: 'serverless.yml', content: SLS, language: 'Serverless' }]);
    const bound = bindDeployHandlers(graph, [code('src/orders.ts', 'create')], { outDir: 'dist' });
    expect(bound.edges).toEqual([]);
    // Not "the project declares no rootDir": only the root tsconfig was read, and an `extends`
    // chain is not followed, so the reason says that instead of over-claiming.
    expect(bound.unresolved[0].reason).toMatch(/repository root's tsconfig\.json declares no rootDir \(an extends chain is not followed\)/);
  });

  it('binds a Serverless handler that names source directly', () => {
    const graph = extractServerless([{ path: 'serverless.yml', content: SLS.replace('dist/orders.create', 'src/orders.create'), language: 'Serverless' }]);
    const bound = bindDeployHandlers(graph, [code('src/orders.ts', 'create')]);
    expect(bound.edges.map(e => e.calleeId)).toEqual(['src/orders.ts::create']);
  });

  it('does not apply the root mapping inside a manifest\'s own directory', () => {
    const graph = extractServerless([{ path: 'services/api/serverless.yml', content: SLS, language: 'Serverless' }]);
    // The root tsconfig describes `dist` → `src` at the ROOT; `services/src/orders.ts` is a file
    // it never described, so binding to it would be a guess.
    const bound = bindDeployHandlers(graph, [code('services/src/orders.ts', 'create')], { outDir: 'dist', rootDir: 'src' });
    expect(bound.edges).toEqual([]);
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
