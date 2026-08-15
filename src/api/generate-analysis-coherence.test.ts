import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { loadAnalysis as loadCliAnalysis } from '../cli/commands/generate.js';
import { GenerateAnalysisError, loadAnalysisData as loadApiAnalysis } from './generate.js';
import { publishGeneration, REQUIRED_ANALYSIS_ARTIFACTS } from '../core/runtime/analysis-generation.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function repo(version: string): Record<string, unknown> {
  return {
    version,
    projectName: version,
    projectType: 'node-typescript',
    frameworks: [],
    architecture: { pattern: 'modular', layers: [] },
    domains: [], entryPoints: [], dataFlow: {}, keyFiles: {}, uiComponents: [], schemas: [], middleware: [], envVars: [],
    routeInventory: { total: 0, byMethod: {}, byFramework: {}, routes: [] },
    statistics: { totalFiles: 1, analyzedFiles: 1, skippedFiles: 0, avgFileScore: 1, nodeCount: 1, edgeCount: 0, cycleCount: 0, clusterCount: 0 },
  };
}

function context(version: string): Record<string, unknown> {
  return {
    version,
    phase1_survey: { purpose: version, files: [], estimatedTokens: 0 },
    phase2_deep: { purpose: version, files: [], totalTokens: 0 },
    phase3_validation: { purpose: version, files: [], totalTokens: 0 },
  };
}

function graph(version: string): Record<string, unknown> {
  return { version, nodes: [], edges: [], clusters: [], cycles: [], statistics: {} };
}

async function writeGeneration(dir: string, version: string, publish = true): Promise<void> {
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeFile(join(dir, 'repo-structure.json'), JSON.stringify(repo(version))),
    writeFile(join(dir, 'llm-context.json'), JSON.stringify(context(version))),
    writeFile(join(dir, 'dependency-graph.json'), JSON.stringify(graph(version))),
    writeFile(join(dir, 'fingerprint.json'), JSON.stringify({ hash: version })),
  ]);
  if (publish) await publishGeneration(dir, [...REQUIRED_ANALYSIS_ARTIFACTS]);
}

async function fixture(version = 'A'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'openlore-generate-coherence-'));
  roots.push(root);
  const dir = join(root, '.openlore', 'analysis');
  await writeGeneration(dir, version);
  return dir;
}

type Reader = <T>(path: string, label: string) => Promise<T | null>;

function barrierReader(): {
  reader: Reader;
  repoRead: Promise<void>;
  release: () => void;
} {
  let announce!: () => void;
  let release!: () => void;
  const repoRead = new Promise<void>(resolve => { announce = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const reader: Reader = async <T>(path: string, label: string): Promise<T | null> => {
    if (first && label === 'repo-structure.json') {
      first = false;
      const raw = await readFile(path, 'utf8');
      announce();
      await gate;
      return JSON.parse(raw) as T;
    }
    if (!first) await gate;
    try { return JSON.parse(await readFile(path, 'utf8')) as T; }
    catch { return null; }
  };
  return { reader, repoRead, release };
}

describe.each([
  ['CLI', loadCliAnalysis],
  ['API', loadApiAnalysis],
] as const)('%s generation analysis reader', (_surface, load) => {
  it('retries a generation swap and never returns the deliberately mixed first attempt', async () => {
    const dir = await fixture('A');
    const barrier = barrierReader();
    const loading = load(dir, barrier.reader);
    await barrier.repoRead;
    await writeGeneration(dir, 'B');
    barrier.release();

    const result = await loading;
    const loaded = (_surface === 'CLI'
      ? (result as Awaited<ReturnType<typeof loadCliAnalysis>> & { state: 'ok' }).data
      : result) as {
        repoStructure: unknown;
        llmContext: unknown;
        depGraph?: unknown;
        generationCompatibility: string;
      };
    expect((loaded.repoStructure as unknown as { version: string }).version).toBe('B');
    expect((loaded.llmContext as unknown as { version: string }).version).toBe('B');
    expect((loaded.depGraph as unknown as { version: string }).version).toBe('B');
    expect(loaded.generationCompatibility).toBe('manifest');
  });

  it('fails typed when required bytes change without a manifest commit', async () => {
    const dir = await fixture('A');
    const barrier = barrierReader();
    const loading = load(dir, barrier.reader);
    await barrier.repoRead;
    await writeFile(join(dir, 'llm-context.json'), JSON.stringify(context('UNCOMMITTED')));
    barrier.release();

    if (_surface === 'CLI') {
      await expect(loading).resolves.toMatchObject({ state: 'analysis-changed' });
    } else {
      await expect(loading).rejects.toMatchObject({
        name: 'GenerateAnalysisError', code: 'analysis-changed',
      } satisfies Partial<GenerateAnalysisError>);
    }
  });

  it('keeps custom pre-manifest analysis readable and discloses legacy compatibility', async () => {
    const root = await mkdtemp(join(tmpdir(), 'openlore-generate-legacy-'));
    roots.push(root);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'repo-structure.json'), JSON.stringify(repo('LEGACY')));
    await writeFile(join(root, 'llm-context.json'), JSON.stringify(context('LEGACY')));

    const loaded = await load(root, async <T>(path: string): Promise<T | null> => {
      try { return JSON.parse(await readFile(path, 'utf8')) as T; }
      catch { return null; }
    });
    if (_surface === 'CLI') {
      expect(loaded).toMatchObject({ state: 'ok', data: { generationCompatibility: 'legacy' } });
    } else {
      expect(loaded).toMatchObject({ generationCompatibility: 'legacy' });
    }
  });
});

it('the fixture publishes exactly the four required generation artifacts', async () => {
  expect([...REQUIRED_ANALYSIS_ARTIFACTS].map(name => basename(name))).toEqual([
    'repo-structure.json', 'llm-context.json', 'dependency-graph.json', 'fingerprint.json',
  ]);
});
