/**
 * `doctor` must report the retrieval mode the index SERVES, not the one its
 * configuration asks for (change: make-index-self-state-honest).
 *
 * The case: on 2026-09-20 the endpoint check passed — `✓ … 384 dims · 1952ms` — over an
 * index with `hasEmbeddings: false`, in two repositories, for days.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRetrievalMode } from './doctor.js';
import { _resetVectorIndexCachesForTesting } from '../../core/analyzer/vector-index.js';

const ANALYSIS = join('.openlore', 'analysis');

describe('doctor — retrieval mode served', () => {
  let root: string;
  const savedBaseUrl = process.env.EMBED_BASE_URL;
  const savedModel = process.env.EMBED_MODEL;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-doctor-mode-'));
    delete process.env.EMBED_BASE_URL;
    delete process.env.EMBED_MODEL;
    _resetVectorIndexCachesForTesting();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    if (savedBaseUrl === undefined) delete process.env.EMBED_BASE_URL; else process.env.EMBED_BASE_URL = savedBaseUrl;
    if (savedModel === undefined) delete process.env.EMBED_MODEL; else process.env.EMBED_MODEL = savedModel;
  });

  /** Build the on-disk shape `VectorIndex.exists` accepts, with a chosen capability. */
  async function withIndex(hasEmbeddings: boolean): Promise<string> {
    const analysisDir = join(root, ANALYSIS);
    await mkdir(join(analysisDir, 'vector-index'), { recursive: true });
    await writeFile(join(analysisDir, 'vector-index-meta.json'), JSON.stringify({
      hasEmbeddings,
      dim: hasEmbeddings ? 384 : 0,
      model: hasEmbeddings ? 'all-MiniLM-L6-v2' : null,
      builtAt: new Date().toISOString(),
      schemaVersion: 1,
      tokenizerVersion: 2,
    }), 'utf-8');
    return analysisDir;
  }

  /** A config the product's own validator accepts — an invalid one is a different test. */
  const writeConfig = async (embedding: Record<string, unknown> | null): Promise<void> => {
    await mkdir(join(root, '.openlore'), { recursive: true });
    await writeFile(join(root, '.openlore', 'config.json'), JSON.stringify({
      version: '1.0.0',
      projectType: 'nodejs',
      openspecPath: './openspec',
      analysis: { maxFiles: 500, includePatterns: [], excludePatterns: [] },
      generation: { provider: 'anthropic', model: 'claude-sonnet-5' },
      createdAt: '2026-09-20T00:00:00.000Z',
      lastRun: null,
      ...(embedding ? { embedding } : {}),
    }), 'utf-8');
  };

  it('raises a finding when a provider is configured and the index carries no vectors', async () => {
    await withIndex(false);
    await writeConfig({ baseUrl: 'http://127.0.0.1:8765/v1', model: 'all-MiniLM-L6-v2' });

    const check = await checkRetrievalMode(root);

    expect(check.name).toBe('Retrieval mode');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('no vectors');
    expect(check.fix).toContain('analyze --force');
  });

  it('passes on the unconfigured keyword default without calling it a problem', async () => {
    await withIndex(false);
    await writeConfig(null);

    const check = await checkRetrievalMode(root);

    expect(check.status).toBe('ok');
    expect(check.detail).toContain('keyword');
    expect(check.detail).toContain('first-class default');
    expect(check.fix).toBeUndefined();
  });

  it('reports the semantic mode when the configured provider is realized', async () => {
    await withIndex(true);
    await writeConfig({ baseUrl: 'http://127.0.0.1:8765/v1', model: 'all-MiniLM-L6-v2' });
    process.env.EMBED_BASE_URL = 'http://127.0.0.1:8765/v1';
    process.env.EMBED_MODEL = 'all-MiniLM-L6-v2';

    const check = await checkRetrievalMode(root);

    expect(check.status).toBe('ok');
    expect(check.detail).toContain('remote-semantic');
  });

  it('surfaces a recorded embed failure from the receipt', async () => {
    const analysisDir = await withIndex(true);
    await writeConfig({ baseUrl: 'http://127.0.0.1:8765/v1', model: 'all-MiniLM-L6-v2' });
    process.env.EMBED_BASE_URL = 'http://127.0.0.1:8765/v1';
    process.env.EMBED_MODEL = 'all-MiniLM-L6-v2';
    await writeFile(join(analysisDir, 'analysis-indexes.json'), JSON.stringify({
      embedFailure: { at: '2026-09-20T15:40:00.000Z', reason: 'fetch failed', endpoint: 'http://127.0.0.1:8765/v1' },
    }), 'utf-8');

    const check = await checkRetrievalMode(root);

    expect(check.status).toBe('warn');
    expect(check.detail).toContain('fetch failed');
    expect(check.detail).toContain('2026-09-20T15:40:00.000Z');
  });

  it('refuses to call an unreadable configuration "no provider configured"', async () => {
    await withIndex(false);
    await mkdir(join(root, '.openlore'), { recursive: true });
    // Missing the sections the validator requires: readable JSON, invalid configuration.
    await writeFile(join(root, '.openlore', 'config.json'), JSON.stringify({ version: '1.0.0', projectType: 'nodejs' }), 'utf-8');

    const check = await checkRetrievalMode(root);

    expect(check.status).toBe('warn');
    expect(check.detail).toContain('could not be read');
    expect(check.detail).not.toContain('first-class default');
  });

  it('names the command that builds an index when there is none', async () => {
    await writeConfig(null);

    const check = await checkRetrievalMode(root);

    expect(check.status).toBe('warn');
    expect(check.detail).toContain('no search index');
    expect(check.fix).toContain('openlore analyze');
  });
});
