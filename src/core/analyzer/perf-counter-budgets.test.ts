import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { measurePerfWorkForTests, recordPerfWork } from './perf-counters.js';
import { writeJsonAtomicStreaming } from './json-stream.js';
import { parseWithBudget } from './parse-budget.js';
import { atomicWriteFile } from '../decisions/atomic-store.js';
import { EdgeStore } from '../services/edge-store.js';
import { buildAdjacency } from '../services/mcp-handlers/graph.js';
import type { FunctionNode, SerializedCallGraph } from './call-graph.js';

const node: FunctionNode = {
  id: 'src/a.ts::a', name: 'a', filePath: 'src/a.ts', language: 'TypeScript',
  isAsync: false, startIndex: 0, endIndex: 10, fanIn: 0, fanOut: 0,
};

describe('deterministic performance counter boundaries', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) {
      // Windows can keep a just-closed SQLite WAL handle busy briefly.
      for (let attempt = 0; attempt < 5; attempt++) {
        try { await rm(dir, { recursive: true, force: true }); break; }
        catch (error) {
          if (attempt === 4) throw error;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
    }
    dir = undefined;
  });

  it('counts a redundant parse through the shared raw parser boundary', async () => {
    const parser = { parse: (_content: string) => ({ rootNode: {} }) };
    const { counters } = await measurePerfWorkForTests(() => {
      parseWithBudget(parser, 'first');
      parseWithBudget(parser, 'redundant');
    });
    expect(counters.sourceParses).toBe(2);
    expect(() => expect(counters.sourceParses).toBe(1)).toThrow();
  });

  it('counts real node-table loads, SQL preparations, and adjacency builds exactly', async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-perf-budget-'));
    const store = EdgeStore.open(join(dir, 'call-graph.db'));
    try {
      store.insertNodes([node]);
      const graph = { nodes: [node], edges: [] } as unknown as SerializedCallGraph;
      const { result, counters } = await measurePerfWorkForTests(() => {
        const nodes = store.getAllInternalNodes();
        const adjacency = buildAdjacency(graph);
        return { nodes, adjacency };
      });

      expect(result.nodes.map(n => n.id)).toEqual([node.id]);
      expect(result.adjacency.forward.has(node.id)).toBe(true);
      expect(counters.fullNodeTableLoads).toBe(1);
      expect(counters.edgeStoreStatementPrepares).toBe(1);
      expect(counters.adjacencyBuilds).toBe(1);
      expect(counters.atomicArtifactPayloadBytes).toBe(0);

      // This deliberately reintroduces an extra full load. The same exact budget
      // that guards watcher/analyze work must reject it, proving the hook is live.
      const redundant = await measurePerfWorkForTests(() => {
        store.getAllInternalNodes();
        store.getAllInternalNodes();
      });
      expect(redundant.counters.fullNodeTableLoads).toBe(2);
      expect(redundant.counters.edgeStoreStatementPrepares).toBe(2);
      expect(() => expect(redundant.counters.fullNodeTableLoads).toBe(1)).toThrow();

      const rebuilt = await measurePerfWorkForTests(() => {
        buildAdjacency(graph);
        buildAdjacency(graph);
      });
      expect(rebuilt.counters.adjacencyBuilds).toBe(2);
      expect(() => expect(rebuilt.counters.adjacencyBuilds).toBe(1)).toThrow();
    } finally {
      store.close();
    }
  });

  it('counts UTF-8 payload bytes across both atomic artifact writers, only inside a scope', async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-perf-bytes-'));
    const text = 'é';
    const jsonValue = { label: text };
    const directPath = join(dir, 'direct.json');
    const streamedPath = join(dir, 'streamed.json');
    const { counters } = await measurePerfWorkForTests(async () => {
      await atomicWriteFile(directPath, text);
      await writeJsonAtomicStreaming(streamedPath, jsonValue);
    });
    const streamed = await readFile(streamedPath, 'utf8');
    expect(JSON.parse(streamed)).toEqual(jsonValue);
    expect(await readFile(directPath, 'utf8')).toBe(text);
    expect(counters.atomicArtifactPayloadBytes).toBe(21); // 2 UTF-8 bytes + 19 formatted JSON bytes.
    expect(counters.atomicArtifactPayloadBytes)
      .toBe(Buffer.byteLength(text) + Buffer.byteLength(streamed));
    expect(counters.fullNodeTableLoads).toBe(0);

    const isolated = await measurePerfWorkForTests(() => 42);
    expect(isolated.result).toBe(42);
    expect(isolated.counters.atomicArtifactPayloadBytes).toBe(0);
  });

  it('leaves counters inert when no measurement is active and after a rejected run', async () => {
    recordPerfWork('adjacencyBuilds');
    await expect(measurePerfWorkForTests(() => {
      recordPerfWork('adjacencyBuilds');
      throw new Error('test failure');
    })).rejects.toThrow('test failure');
    recordPerfWork('adjacencyBuilds');
    const next = await measurePerfWorkForTests(() => 1);
    expect(next.counters.adjacencyBuilds).toBe(0);
  });

  it('isolates overlapping async measurement scopes', async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });

    const first = measurePerfWorkForTests(async () => {
      recordPerfWork('adjacencyBuilds');
      await firstGate;
      recordPerfWork('adjacencyBuilds');
    });
    const second = measurePerfWorkForTests(async () => {
      recordPerfWork('adjacencyBuilds', 2);
      await secondGate;
      recordPerfWork('adjacencyBuilds', 2);
    });

    releaseSecond();
    const secondResult = await second;
    releaseFirst();
    const firstResult = await first;
    expect(firstResult.counters.adjacencyBuilds).toBe(2);
    expect(secondResult.counters.adjacencyBuilds).toBe(4);
  });
});
