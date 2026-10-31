/**
 * A full analysis records the content hash of every file it read, so the
 * read path judges a cited file by its bytes and not its mtime.
 *
 * Regression: full analysis cleared `file_hashes` and never wrote it, so freshness fell back
 * to comparing mtimes. A checkout, pull or new worktree that rewrote unchanged files made the
 * index read as "behind the working tree" for every file it touched.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { runAnalysisCore } from './analysis-core.js';
import { EdgeStore } from '../services/edge-store.js';
import { checkCitedFileFreshness } from '../services/mcp-handlers/freshness.js';

const SOURCE = 'export function computeTariff(kwh: number): number { return kwh * 0.12; }\n';

let root: string;
let out: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'analyze-hashes-'));
  out = join(root, '.openlore', 'analysis');
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'tariff.ts'), SOURCE);
  await writeFile(join(root, 'src', 'aliases.json'), '{"kwh":"kilowatt-hour"}\n');
  await runAnalysisCore(root, out, { maxFiles: 200, include: [], exclude: [] });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const withStore = async <T>(fn: (store: EdgeStore) => Promise<T>): Promise<T> => {
  const store = EdgeStore.open(EdgeStore.dbPath(out));
  try { return await fn(store); } finally { store.close(); }
};

describe('full analysis records per-file content hashes', () => {
  it('stores the SHA-256 of the bytes each file was read as', async () => {
    const expected = createHash('sha256').update(SOURCE).digest('hex');
    expect(await withStore(async (store) => store.getFileHash('src/tariff.ts'))).toBe(expected);
  });

  it('a file rewritten with the same content (checkout, pull, new worktree) stays fresh', async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000);
    await utimes(join(root, 'src', 'tariff.ts'), later, later);
    const result = await withStore((edgeStore) => checkCitedFileFreshness(root, ['src/tariff.ts'], { edgeStore }));
    expect(result.staleFiles).toEqual([]);
  });

  it('a cited file outside the call graph (data, config) has a baseline too', async () => {
    const later = new Date(Date.now() + 60 * 60 * 1000);
    await utimes(join(root, 'src', 'aliases.json'), later, later);
    const result = await withStore((edgeStore) => checkCitedFileFreshness(root, ['src/aliases.json'], { edgeStore }));
    expect(result.staleFiles).toEqual([]);
  });

  it('a file whose content changed is stale', async () => {
    await writeFile(join(root, 'src', 'tariff.ts'), `${SOURCE}export const changed = true;\n`);
    const result = await withStore((edgeStore) => checkCitedFileFreshness(root, ['src/tariff.ts'], { edgeStore }));
    expect(result.staleFiles).toEqual(['src/tariff.ts']);
  });
});
