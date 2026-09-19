/**
 * `openlore doctor` corpus-size check (issue #504), against a real directory: no fs
 * mocks, so the walk is the one `openlore analyze` fingerprints.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkAnalysisCorpus } from './doctor.js';

describe('checkAnalysisCorpus', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'doctor-corpus-'));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'app.ts'), 'export const x = 1;\n');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('passes and reports the size of a corpus under the budget', async () => {
    const result = await checkAnalysisCorpus(dir);
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('1 file(s)');
    expect(result.detail).toContain('cap 1 GB');
  });

  // A sparse file reports its full size to stat without using that disk space. Windows
  // may allocate it, so the premise is only built where it is cheap.
  it.skipIf(process.platform === 'win32')('fails and names the heaviest path when analyze would exceed the budget', async () => {
    await mkdir(join(dir, 'tmp', 'dump'), { recursive: true });
    const handle = await open(join(dir, 'tmp', 'dump', 'blob.bin'), 'w');
    await handle.truncate(1024 * 1024 * 1024 + 1);
    await handle.close();

    const result = await checkAnalysisCorpus(dir);

    expect(result.status).toBe('fail');
    expect(result.detail).toContain('fingerprint byte budget exceeded');
    expect(result.detail).toContain('tmp/dump/blob.bin');
    expect(result.fix).toContain('analysis.excludePatterns');
  });

  it.skipIf(process.platform === 'win32')('honors analysis.excludePatterns from the config', async () => {
    await mkdir(join(dir, 'tmp'), { recursive: true });
    const handle = await open(join(dir, 'tmp', 'blob.bin'), 'w');
    await handle.truncate(1024 * 1024 * 1024 + 1);
    await handle.close();
    await mkdir(join(dir, '.openlore'), { recursive: true });
    await writeFile(join(dir, '.openlore', 'config.json'), JSON.stringify({
      version: '1.0.0', projectType: 'nodejs', openspecPath: './openspec',
      analysis: { maxFiles: 500, includePatterns: [], excludePatterns: ['tmp/**'] },
      generation: { model: 'x', domains: 'auto' }, createdAt: '2026-01-01T00:00:00Z', lastRun: null,
    }));

    const result = await checkAnalysisCorpus(dir);

    expect(result.status).toBe('ok');
    expect(result.detail).toContain('1 file(s)');
  });

  it('does not count binary data stores the walker skips by default', async () => {
    await mkdir(join(dir, 'vectors.lance', 'data'), { recursive: true });
    await writeFile(join(dir, 'vectors.lance', 'data', 'part-0.lance'), 'x');
    await writeFile(join(dir, 'table.parquet'), 'x');
    await writeFile(join(dir, 'cache.sqlite'), 'x');

    const result = await checkAnalysisCorpus(dir);

    expect(result.detail).toContain('1 file(s)');
  });
});
