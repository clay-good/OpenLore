/**
 * Periodic compaction of the LanceDB search indexes (change: bulletproof-background-index).
 *
 * The watcher updates an index with `delete` + `add`, and LanceDB is append-only and versioned, so
 * every save leaves the previous version on disk. Nothing reclaimed them, and a machine that just
 * leaves the watcher running never hits the full `analyze` that happens to clean up — measured at
 * 401 MB of index holding 36 MB of live rows on a repository whose source is ~9 MB.
 *
 * The property that matters is BOTH halves: space is actually reclaimed, and not one row is lost
 * doing it. A compaction that quietly dropped rows would turn a disk-space chore into missing
 * search results, which is far worse than the bloat.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  TextLineIndex,
  _resetTextLineIndexCachesForTesting,
} from './text-line-index.js';
import {
  _setCompactEveryForTesting,
  _resetCompactionCountersForTesting,
  _setVersionGraceMsForTesting,
  noteUpdateAndMaybeCompact,
} from './index-compaction.js';

let outputDir: string;
let restoreEvery = 0;
let restoreGrace = 0;

beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), 'ol-compact-'));
  _resetTextLineIndexCachesForTesting();
  _resetCompactionCountersForTesting();
  restoreEvery = _setCompactEveryForTesting(5);
  // Versions created seconds ago are inside the production reader-safety window, so nothing would
  // be reclaimable and the assertion below could not fail. Shrink it for the fixture.
  restoreGrace = _setVersionGraceMsForTesting(0);
});

afterEach(async () => {
  _setCompactEveryForTesting(restoreEvery);
  _setVersionGraceMsForTesting(restoreGrace);
  _resetCompactionCountersForTesting();
  _resetTextLineIndexCachesForTesting();
  await rm(outputDir, { recursive: true, force: true });
});

/** How many LanceDB versions the index directory is carrying. */
async function versionCount(dir: string): Promise<number> {
  const root = join(dir, 'text-line-index');
  const tables = await readdir(root).catch(() => [] as string[]);
  for (const t of tables) {
    if (!t.endsWith('.lance')) continue;
    const versions = await readdir(join(root, t, '_versions')).catch(() => [] as string[]);
    return versions.length;
  }
  return 0;
}

describe('search-index compaction', () => {
  it('reclaims accumulated versions without losing a single row', async () => {
    await TextLineIndex.build(outputDir, [
      { filePath: 'a.ts', content: 'const zebracrossing = 1;\nconst other = 2;\n' },
      { filePath: 'b.ts', content: 'const plumbago = 3;\n' },
    ]);

    // Enough saves to cross the (lowered) compaction threshold several times.
    for (let i = 0; i < 24; i++) {
      await TextLineIndex.updateFiles(outputDir, [
        { filePath: 'a.ts', content: `const zebracrossing = ${i};\nconst other = 2;\n` },
      ]);
    }

    // Versions must not have grown once per save — that is the unbounded growth being fixed.
    const versions = await versionCount(outputDir);
    expect(versions, `index carried ${versions} versions after 24 saves`).toBeLessThan(24);

    // …and every file is still searchable, including the one never touched by the updates.
    _resetTextLineIndexCachesForTesting();
    expect((await TextLineIndex.searchText(outputDir, 'zebracrossing')).length).toBeGreaterThan(0);
    _resetTextLineIndexCachesForTesting();
    const plumbago = await TextLineIndex.searchText(outputDir, 'plumbago');
    expect(plumbago.length, 'an untouched file lost its rows to compaction').toBeGreaterThan(0);
    expect(plumbago[0].filePath).toBe('b.ts');
  }, 120_000);

  it('compacts on a counter, not on every update', async () => {
    // Compaction costs a few hundred milliseconds on a real index. Doing it per save would put
    // that on every keystroke; doing it never is the bug. So it must be neither.
    const calls: number[] = [];
    const fake = { optimize: async () => { calls.push(1); return {}; } };

    for (let i = 0; i < 12; i++) await noteUpdateAndMaybeCompact('/fake/idx', fake);

    // Threshold is 5 in these tests: 12 updates => 2 compactions.
    expect(calls.length).toBe(2);
  });

  it('counts each index separately, so one busy index cannot starve another', async () => {
    const a: number[] = [];
    const b: number[] = [];
    const fakeA = { optimize: async () => { a.push(1); return {}; } };
    const fakeB = { optimize: async () => { b.push(1); return {}; } };

    for (let i = 0; i < 4; i++) await noteUpdateAndMaybeCompact('/idx/a', fakeA);
    for (let i = 0; i < 5; i++) await noteUpdateAndMaybeCompact('/idx/b', fakeB);

    expect(a.length, 'A had not reached the threshold').toBe(0);
    expect(b.length, 'B had reached the threshold').toBe(1);
  });

  it('never lets a compaction failure break the update that triggered it', async () => {
    // Compaction is a space optimization. Surfacing its error would turn a disk-space chore into
    // a failed file save, which is a strictly worse outcome than staying bloated.
    const exploding = { optimize: async () => { throw new Error('disk full'); } };
    for (let i = 0; i < 4; i++) await noteUpdateAndMaybeCompact('/idx/boom', exploding);
    await expect(noteUpdateAndMaybeCompact('/idx/boom', exploding)).resolves.toBe(false);
  });
});
