import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeEdgesToSQLite } from './artifact-generator.js';
import type { SerializedCallGraph, FunctionNode } from './call-graph.js';
import type { CfgSpill } from './cfg-spill.js';
import { EdgeStore } from '../services/edge-store.js';

function graph(name: string): SerializedCallGraph {
  const entry: FunctionNode = {
    id: `src/${name}.ts::${name}`,
    name,
    filePath: `src/${name}.ts`,
    isAsync: false,
    language: 'TypeScript',
    startIndex: 0,
    endIndex: 1,
    fanIn: 0,
    fanOut: 1,
  };
  const leaf: FunctionNode = {
    ...entry,
    id: `src/${name}.ts::${name}Leaf`,
    name: `${name}Leaf`,
    startIndex: 2,
    endIndex: 3,
    fanIn: 1,
    fanOut: 0,
  };
  return {
    nodes: [entry, leaf],
    edges: [{
      callerId: entry.id,
      calleeId: leaf.id,
      calleeName: leaf.name,
      confidence: 'same_file',
      line: 1,
    }],
    classes: [],
    inheritanceEdges: [],
    hubFunctions: [],
    entryPoints: [],
    layerViolations: [],
    stats: { totalNodes: 2, totalEdges: 1, avgFanIn: 0.5, avgFanOut: 0.5 },
  };
}

describe('harden-analyze-rebuild-atomicity', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function databasePath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'analyze-rebuild-atomicity-'));
    dirs.push(dir);
    return EdgeStore.dbPath(dir);
  }

  it('keeps the previous complete graph visible until the replacement commits', async () => {
    const dbPath = await databasePath();
    await writeEdgesToSQLite(graph('old'), dbPath);
    const reader = EdgeStore.open(dbPath);

    let enteredDrain!: () => void;
    const draining = new Promise<void>((resolve) => { enteredDrain = resolve; });
    let releaseDrain!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseDrain = resolve; });
    const spill = {
      failed: false,
      async *drain() {
        enteredDrain();
        await blocked;
        yield { functionId: 'src/new.ts::new', filePath: 'src/new.ts', cfgJson: '{}' };
      },
    } as unknown as CfgSpill;

    const replacement = writeEdgesToSQLite(graph('new'), dbPath, undefined, undefined, undefined, spill);
    await draining;
    try {
      expect(reader.getAllInternalNodes().map((node) => node.name)).toEqual(['old', 'oldLeaf']);
      expect(reader.countEdges()).toBe(1);
    } finally {
      releaseDrain();
    }
    await replacement;
    expect(reader.getAllInternalNodes().map((node) => node.name)).toEqual(['new', 'newLeaf']);
    expect(reader.countEdges()).toBe(1);
    reader.close();
  });

  it('rolls a failed replacement back to the previous complete graph', async () => {
    const dbPath = await databasePath();
    await writeEdgesToSQLite(graph('old'), dbPath);
    const crashingSpill = {
      failed: false,
      async *drain() {
        throw new Error('simulated rebuild interruption');
        yield { functionId: 'unreachable', filePath: 'unreachable', cfgJson: '{}' };
      },
    } as unknown as CfgSpill;

    await expect(
      writeEdgesToSQLite(graph('new'), dbPath, undefined, undefined, undefined, crashingSpill),
    ).rejects.toThrow('simulated rebuild interruption');

    const reader = EdgeStore.open(dbPath);
    try {
      expect(reader.getAllInternalNodes().map((node) => node.name)).toEqual(['old', 'oldLeaf']);
      expect(reader.countEdges()).toBe(1);
    } finally {
      reader.close();
    }
  });
});
