import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CallGraphBuilder } from '../analyzer/call-graph.js';
import { buildGraphSubset } from './mcp-watcher.js';

describe('buildGraphSubset — HTTP topology convergence', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'openlore-watcher-http-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('adds and removes an edge when a Go client changes without an existing caller edge', async () => {
    const route = '@app.get("/items")\ndef items():\n    return []\n';
    await writeFile(join(rootDir, 'api.py'), route);
    const routeGraph = await new CallGraphBuilder().build([
      { path: 'api.py', content: route, language: 'Python' },
    ]);

    const added = await buildGraphSubset(
      'client.go',
      'package p\nimport "net/http"\nfunc load(){ http.Get("/items") }',
      [],
      rootDir,
      [...routeGraph.nodes.values()],
    );
    expect(added.edges.some(edge => edge.confidence === 'http_endpoint')).toBe(true);

    const removed = await buildGraphSubset(
      'client.go',
      'package p\nfunc load() {}',
      [],
      rootDir,
      [...routeGraph.nodes.values()],
    );
    expect(removed.edges.some(edge => edge.confidence === 'http_endpoint')).toBe(false);
  });

  it('adds and removes an incoming edge when a Python route changes', async () => {
    const client = 'package p\nimport "net/http"\nfunc load(){ http.Get("/items") }';
    await writeFile(join(rootDir, 'client.go'), client);
    const clientGraph = await new CallGraphBuilder().build([
      { path: 'client.go', content: client, language: 'Go' },
    ]);

    const added = await buildGraphSubset(
      'api.py',
      '@app.get("/items")\ndef items():\n    return []\n',
      [],
      rootDir,
      [...clientGraph.nodes.values()],
    );
    expect(added.edges.some(edge => edge.confidence === 'http_endpoint')).toBe(true);

    const removed = await buildGraphSubset(
      'api.py',
      '@app.get("/other")\ndef items():\n    return []\n',
      [],
      rootDir,
      [...clientGraph.nodes.values()],
    );
    expect(removed.edges.some(edge => edge.confidence === 'http_endpoint')).toBe(false);
  });

  it('does not scan or stale unrelated HTTP-capable extensions on an ordinary edit', async () => {
    const resolutionNodes = [];
    for (let i = 0; i < 65; i++) {
      const path = `plain-${String(i).padStart(2, '0')}.ts`;
      const source = `export function plain${i}() { return ${i}; }`;
      await writeFile(join(rootDir, path), source);
      resolutionNodes.push({
        id: `${path}::plain${i}`, name: `plain${i}`, filePath: path,
        language: 'TypeScript', isAsync: false, startIndex: 0, endIndex: source.length,
        fanIn: 0, fanOut: 0,
      });
    }

    const result = await buildGraphSubset(
      'changed.ts',
      'export function changed() { return 1; }',
      [],
      rootDir,
      resolutionNodes,
    );

    expect(result.skipped).toEqual([]);
    expect([...result.analyzedFileHashes.keys()]).toEqual(['changed.ts']);
  });
});
