/**
 * Precedence between a published artifact and a partial first-run index
 * (change: refine-first-run-partial-serving).
 *
 * The load-bearing property of the whole change, and the one most easily lost in a refactor: a
 * partial index may answer ONLY during a genuine first build. Standing it in for a published
 * artifact that is corrupt, oversized or a symlink would turn a problem the operator needs to
 * see into a quiet downgrade, which is the opposite of what this lane is for.
 *
 * Deliberately drives the real readers against real files — `graph.test.ts` mocks
 * `artifact-cache.js` wholesale, so nothing there exercises this.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flushPartialIndex, type PartialIndexStamp } from '../../runtime/partial-index.js';
import {
  readAnalysisArtifactOrPartial,
  readDependencyGraphOrPartial,
  _resetJsonArtifactCacheForTesting,
} from './artifact-cache.js';

let root: string;
let analysisDir: string;

const PARTIAL_GRAPH = { nodes: [{ id: 'p' }], edges: [], marker: 'from-partial' };

async function plantPartial(): Promise<void> {
  const stamp: PartialIndexStamp = {
    partial: true, phase: 'extractors', buildPhase: 'extractors',
    filesExtracted: 0, filesTotal: 1, filesMapped: 1,
    startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    pid: process.pid, analysisDir,
  };
  await flushPartialIndex(analysisDir, {
    repoStructure: { marker: 'from-partial' },
    llmContext: { partial: stamp },
    dependencyGraph: PARTIAL_GRAPH,
    stamp,
  });
}

beforeEach(async () => {
  _resetJsonArtifactCacheForTesting();
  root = await mkdtemp(join(tmpdir(), 'openlore-precedence-'));
  analysisDir = join(root, '.openlore', 'analysis');
  await mkdir(analysisDir, { recursive: true });
});

afterEach(async () => {
  _resetJsonArtifactCacheForTesting();
  await rm(root, { recursive: true, force: true });
});

describe('a partial index answers only during a genuine first build', () => {
  it('answers when nothing is published', async () => {
    await plantPartial();

    const graph = await readDependencyGraphOrPartial<typeof PARTIAL_GRAPH>(analysisDir, 'dependency-graph.json');
    const structure = await readAnalysisArtifactOrPartial(analysisDir, 'repo-structure.json');

    expect(graph?.marker).toBe('from-partial');
    expect(JSON.parse(structure!).marker).toBe('from-partial');
  });

  it('does not stand in for a published artifact that is corrupt', async () => {
    await writeFile(join(analysisDir, 'dependency-graph.json'), 'not json at all', 'utf8');
    await plantPartial();

    // The published read fails, and it must keep failing: the operator has a broken artifact.
    expect(await readDependencyGraphOrPartial(analysisDir, 'dependency-graph.json')).toBeNull();
  });

  it('does not stand in for a published artifact that parses but has no graph', async () => {
    await writeFile(join(analysisDir, 'dependency-graph.json'), '{}', 'utf8');
    await plantPartial();

    expect(await readDependencyGraphOrPartial(analysisDir, 'dependency-graph.json')).toBeNull();
  });

  it('does not stand in for a published artifact that is a symlink', async () => {
    await writeFile(join(root, 'elsewhere.json'), JSON.stringify({ nodes: [], edges: [] }), 'utf8');
    await symlink(join(root, 'elsewhere.json'), join(analysisDir, 'dependency-graph.json'));
    await plantPartial();

    expect(await readDependencyGraphOrPartial(analysisDir, 'dependency-graph.json')).toBeNull();
  });

  it('does not answer when a published context exists but its graph is missing', async () => {
    // A broken artifact set, not a first build. Answering it from the partial index would bind
    // one artifact to the other's generation — the mixture the generation manifest exists to
    // refuse.
    await writeFile(join(analysisDir, 'llm-context.json'), '{"phase1_survey":{}}', 'utf8');
    await plantPartial();

    expect(await readDependencyGraphOrPartial(analysisDir, 'dependency-graph.json')).toBeNull();
    expect(await readAnalysisArtifactOrPartial(analysisDir, 'repo-structure.json')).toBeNull();
  });

  it('serves the published artifact, never the partial one, when both exist', async () => {
    await writeFile(
      join(analysisDir, 'dependency-graph.json'),
      JSON.stringify({ nodes: [], edges: [], marker: 'from-published' }),
      'utf8',
    );
    await plantPartial();

    const graph = await readDependencyGraphOrPartial<typeof PARTIAL_GRAPH>(analysisDir, 'dependency-graph.json');
    expect(graph?.marker).toBe('from-published');
  });
});
