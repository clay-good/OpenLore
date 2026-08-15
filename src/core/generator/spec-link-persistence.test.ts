import { afterEach, describe, expect, it } from 'vitest';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeSpecLinkIndex } from './spec-link-service.js';
import type { SpecLinkIndex } from './spec-link-index.js';

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

function index(): SpecLinkIndex {
  return {
    version: 3,
    generatedAt: '2026-01-01T00:00:00.000Z',
    analysisGeneration: 'analysis',
    sourceAnalysisFingerprint: 'analysis',
    specCorpusDigest: 'specs',
    mappings: [],
    stats: { totalRequirements: 0, linked: 0, ambiguous: 0, unmapped: 0, stale: 0 },
  } as unknown as SpecLinkIndex;
}

describe('spec-link persistence confinement', () => {
  it('refuses a mapping symlink instead of following it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mapping-persist-'));
    roots.push(root);
    const analysis = join(root, '.openlore', 'analysis');
    await mkdir(analysis, { recursive: true });
    const victim = join(root, 'victim.json');
    await writeFile(victim, 'ORIGINAL');
    const mapping = join(analysis, 'mapping.json');
    await symlink(victim, mapping);

    await expect(writeSpecLinkIndex(root, index())).rejects.toThrow(/outside/);

    expect(await readFile(victim, 'utf-8')).toBe('ORIGINAL');
    expect((await lstat(mapping)).isSymbolicLink()).toBe(true);
  });

  it('refuses an analysis directory symlink that escapes the project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mapping-root-'));
    const outside = await mkdtemp(join(tmpdir(), 'mapping-outside-'));
    roots.push(root, outside);
    await mkdir(join(root, '.openlore'));
    await symlink(outside, join(root, '.openlore', 'analysis'));
    await expect(writeSpecLinkIndex(root, index())).rejects.toThrow(/outside/);
  });
});
