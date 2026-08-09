/**
 * Spec-16 wiring test: writeEdgesToSQLite projects the on-disk decision store
 * onto the EdgeStore (decision nodes + `affects` edges) with path normalization,
 * end-to-end. The projector itself is unit-tested in decisions/project.test.ts;
 * this guards the persistence seam (load store → project → normalize → insert).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeEdgesToSQLite } from './artifact-generator.js';
import { EdgeStore } from '../services/edge-store.js';
import type { SerializedCallGraph } from './call-graph.js';
import type { DecisionStore } from '../../types/index.js';

function makeCallGraph(rootPath: string): SerializedCallGraph {
  const node = {
    id: `${rootPath}/src/a.ts::foo`,
    name: 'foo',
    filePath: `${rootPath}/src/a.ts`,
    isAsync: false,
    language: 'typescript',
    startIndex: 0,
    endIndex: 10,
    fanIn: 0,
    fanOut: 0,
  };
  return {
    nodes: [node],
    edges: [],
    classes: [],
    inheritanceEdges: [],
    hubFunctions: [],
    entryPoints: [node],
    layerViolations: [],
    stats: { totalNodes: 1, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
  };
}

async function writeStore(rootPath: string, store: DecisionStore): Promise<void> {
  const dir = join(rootPath, '.openlore', 'decisions');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'pending.json'), JSON.stringify(store, null, 2), 'utf-8');
}

describe('writeEdgesToSQLite — decision projection (spec-16)', () => {
  let root: string;
  let dbPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'decision-proj-'));
    dbPath = join(root, 'call-graph.db');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('projects an active decision and normalizes affected file paths to relative', async () => {
    await writeStore(root, {
      version: '1', sessionId: 's', updatedAt: 'x',
      decisions: [{
        id: 'c6d1ad07', status: 'verified',
        title: 'North star substrate', rationale: 'r', consequences: 'c',
        proposedRequirement: null,
        affectedDomains: ['overview'],
        affectedFiles: ['src/a.ts'],   // repo-relative, as record_decision stores
        sessionId: 's', recordedAt: 'x', contentOrigin: 'agent-recorded', confidence: 'high', syncedToSpecs: [],
      }],
    });

    await writeEdgesToSQLite(makeCallGraph(root), dbPath, root);

    const store = EdgeStore.open(dbPath);
    try {
      expect(store.countDecisions()).toBe(1);
      // The function node was stored relative ("src/a.ts::foo"); the decision edge
      // must match that form so the graph join resolves.
      const govs = store.getDecisionsForFiles(['src/a.ts']);
      expect(govs.map(d => d.decisionId)).toEqual(['c6d1ad07']);
    } finally {
      store.close();
    }
  });

  it('an empty store projects to zero decision nodes', async () => {
    await writeStore(root, { version: '1', sessionId: 's', updatedAt: 'x', decisions: [] });
    await writeEdgesToSQLite(makeCallGraph(root), dbPath, root);
    const store = EdgeStore.open(dbPath);
    try {
      expect(store.countDecisions()).toBe(0);
    } finally {
      store.close();
    }
  });

  it('a missing store does not fail the graph write', async () => {
    // No .openlore/decisions/pending.json at all.
    await writeEdgesToSQLite(makeCallGraph(root), dbPath, root);
    const store = EdgeStore.open(dbPath);
    try {
      expect(store.countDecisions()).toBe(0);
      expect(store.countNodes()).toBe(1);
    } finally {
      store.close();
    }
  });
});
