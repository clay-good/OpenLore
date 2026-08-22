import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openloreRun } from './run.js';

describe('openloreRun dry run', () => {
  let rootPath: string | undefined;

  afterEach(async () => {
    if (rootPath) await rm(rootPath, { recursive: true, force: true });
  });

  it('leaves a fresh project tree byte-for-byte unchanged', async () => {
    rootPath = await mkdtemp(join(tmpdir(), 'openlore-run-dry-'));
    const before = await readdir(rootPath, { recursive: true });

    const result = await openloreRun({ rootPath, dryRun: true });

    const after = await readdir(rootPath, { recursive: true });
    expect(result).toMatchObject({
      dryRun: true,
      plan: { init: true, analyze: true, generate: true },
      generation: { dryRun: true },
    });
    expect(before).toEqual([]);
    expect(after).toEqual(before);
  });
});
