import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkCorpusIntegrity, checkOpenSpecDir } from './doctor.js';

let root: string;

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function project(openspecPath: string): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'openlore-doctor-spec-source-'));
  await mkdir(join(root, '.openlore'), { recursive: true });
  await writeFile(join(root, '.openlore', 'config.json'), JSON.stringify({
    version: '1.0.0', projectType: 'unknown', openspecPath,
    analysis: { maxFiles: 1000, includePatterns: [], excludePatterns: [] },
    generation: { model: 'x', domains: 'auto' },
    createdAt: new Date().toISOString(), lastRun: null,
  }));
}

describe('doctor spec source check', () => {
  it('reports the configured spec root', async () => {
    await project('./docs/');
    await mkdir(join(root, 'docs', 'specs'), { recursive: true });
    expect((await checkOpenSpecDir(root)).detail).toBe('openspec: docs/specs/');
  });

  it('never reports a spec root outside the project, as every other command falls back', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'openlore-doctor-outside-'));
    try {
      await mkdir(join(outside, 'specs'), { recursive: true });
      // `../<outside>` from the project root: it exists, but must not be probed or reported.
      await project(`../${basename(outside)}`);
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const result = await checkOpenSpecDir(root);
      expect(result.detail).not.toContain(basename(outside));
      expect(result.status).toBe('ok');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('checks corpus integrity at the fallback root, not "unavailable", when openspecPath escapes', async () => {
    await project('../not-this-project');
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const result = await checkCorpusIntegrity(root);
    expect(result.detail).not.toMatch(/unavailable|traversal/i);
  });
});
