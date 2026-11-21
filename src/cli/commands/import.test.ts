import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpecVectorIndex } from '../../core/analyzer/spec-vector-index.js';
import { buildSpecSearchIndex } from './import.js';

let root: string;

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('buildSpecSearchIndex', () => {
  it('indexes specs and decisions at the configured openspecPath', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-import-spec-'));
    await mkdir(join(root, 'docs', 'specs', 'api'), { recursive: true });
    await writeFile(join(root, 'docs', 'specs', 'api', 'spec.md'), '# Api\n');
    await mkdir(join(root, '.openlore'), { recursive: true });
    await writeFile(join(root, '.openlore', 'config.json'), JSON.stringify({
      version: '1.0.0', projectType: 'unknown', openspecPath: 'docs',
      analysis: { maxFiles: 1000, includePatterns: [], excludePatterns: [] },
      generation: { model: 'x', domains: 'auto' },
      createdAt: new Date().toISOString(), lastRun: null,
    }));
    const build = vi.spyOn(SpecVectorIndex, 'build').mockResolvedValue({ recordCount: 1, hasEmbeddings: false });

    expect(await buildSpecSearchIndex(root, join(root, '.openlore', 'analysis'))).toBe(true);
    expect(build).toHaveBeenCalledWith(
      join(root, '.openlore', 'analysis'),
      join(root, 'docs', 'specs'),
      null,
      join(root, '.openlore', 'analysis', 'mapping.json'),
      join(root, 'docs', 'decisions'),
    );
  });
});
