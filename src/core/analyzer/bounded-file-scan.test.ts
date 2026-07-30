/**
 * Bounded repository-wide file scanning (change: fix-unbounded-file-scan-oom).
 *
 * These cover the two properties the fix for issue #302 rests on:
 *  - a scan's peak residency is a function of its CONCURRENCY BOUND, not of the file count, and
 *  - a scan's peak residency is a function of its PER-FILE SIZE CAP, not of any one file's size.
 *
 * Plus the property the rest of the codebase silently depends on: results come back in INPUT
 * order, so artifacts built from a scan stay byte-identical across runs (and across changes to
 * the concurrency bound).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mapFilesBounded, readSourceCapped, isOversizedForScan } from './bounded-file-scan.js';
import { SOURCE_SCAN_MAX_FILE_BYTES, SOURCE_SCAN_CONCURRENCY } from '../../constants.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const tick = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('mapFilesBounded — concurrency is bounded', () => {
  it('never runs more callbacks at once than the requested width', async () => {
    const paths = Array.from({ length: 200 }, (_, i) => `f${i}.ts`);
    let inFlight = 0;
    let peak = 0;

    await mapFilesBounded(paths, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(1);
      inFlight--;
      return null;
    }, 4);

    expect(peak).toBeLessThanOrEqual(4);
    // Sanity: the bound is real work-sharing, not accidental serialization.
    expect(peak).toBeGreaterThan(1);
  });

  it('holds the bound even when one file is far slower than the rest', async () => {
    // A worker stuck on a slow file must not let the others exceed the width, and must not
    // stall them either — workers pull from a shared cursor rather than owning fixed slices.
    const paths = Array.from({ length: 50 }, (_, i) => `f${i}.ts`);
    let inFlight = 0;
    let peak = 0;

    const out = await mapFilesBounded(paths, async (_p, i) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(i === 0 ? 60 : 1);
      inFlight--;
      return i;
    }, 3);

    expect(peak).toBeLessThanOrEqual(3);
    expect(out).toEqual(paths.map((_, i) => i));
  });

  it('visits every path exactly once', async () => {
    const paths = Array.from({ length: 137 }, (_, i) => `f${i}.ts`);
    const seen: string[] = [];
    await mapFilesBounded(paths, async p => { seen.push(p); return null; }, 7);
    expect(seen.slice().sort()).toEqual(paths.slice().sort());
    expect(seen.length).toBe(paths.length);
  });

  it('clamps a nonsensical width instead of stalling or fanning out', async () => {
    const paths = ['a.ts', 'b.ts', 'c.ts'];
    for (const width of [0, -5, Number.NaN, 0.4]) {
      const out = await mapFilesBounded(paths, async (_p, i) => i, width);
      expect(out, `width ${String(width)}`).toEqual([0, 1, 2]);
    }
    // A width above the work available is harmless.
    expect(await mapFilesBounded(paths, async (_p, i) => i, 1000)).toEqual([0, 1, 2]);
  });

  it('returns an empty result for an empty input without invoking the callback', async () => {
    let called = 0;
    expect(await mapFilesBounded([], async () => { called++; return 1; })).toEqual([]);
    expect(called).toBe(0);
  });

  it('defaults to the documented repository-wide bound', async () => {
    const paths = Array.from({ length: 100 }, (_, i) => `f${i}.ts`);
    let peak = 0;
    let inFlight = 0;
    await mapFilesBounded(paths, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick(1);
      inFlight--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(SOURCE_SCAN_CONCURRENCY);
  });
});

describe('mapFilesBounded — results are in INPUT order', () => {
  it('orders by input even when callbacks complete in reverse', async () => {
    // Completion order is deliberately the exact inverse of input order. A shared-array push
    // (or any completion-ordered collection) would produce [9..0]; the artifacts built on top
    // of these scans must not depend on I/O timing.
    const paths = Array.from({ length: 10 }, (_, i) => `f${i}.ts`);
    const out = await mapFilesBounded(paths, async (p, i) => {
      await tick((paths.length - i) * 4);
      return p;
    }, paths.length);
    expect(out).toEqual(paths);
  });

  it('produces the same order at every concurrency width', async () => {
    const paths = Array.from({ length: 40 }, (_, i) => `f${i}.ts`);
    const runs = await Promise.all(
      [1, 2, 8, 64].map(w =>
        mapFilesBounded(paths, async (p, i) => { await tick(i % 3); return p; }, w),
      ),
    );
    for (const r of runs) expect(r).toEqual(paths);
  });
});

describe('mapFilesBounded — failure behaves like Promise.all', () => {
  it('rejects with the callback error and leaves no unhandled rejection', async () => {
    const paths = Array.from({ length: 20 }, (_, i) => `f${i}.ts`);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(
        mapFilesBounded(paths, async (_p, i) => {
          await tick(1);
          if (i % 5 === 0) throw new Error(`boom ${i}`);
          return i;
        }, 4),
      ).rejects.toThrow(/boom/);
      // Give any stray rejection a turn of the loop to surface.
      await tick(20);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});

describe('isOversizedForScan — the threshold exists exactly once', () => {
  it('admits a file exactly at the cap and rejects one byte over', () => {
    expect(isOversizedForScan(SOURCE_SCAN_MAX_FILE_BYTES)).toBe(false);
    expect(isOversizedForScan(SOURCE_SCAN_MAX_FILE_BYTES + 1)).toBe(true);
    expect(isOversizedForScan(0)).toBe(false);
  });
});

describe('readSourceCapped — one file cannot exhaust the heap', () => {
  it('reads a normal file, and skips one over the cap without reading it', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ol-scan-cap-'));
    const small = join(dir, 'small.ts');
    const big = join(dir, 'big.ts');
    writeFileSync(small, 'export const a = 1;\n');
    writeFileSync(big, 'x'.repeat(SOURCE_SCAN_MAX_FILE_BYTES + 1024));

    expect(await readSourceCapped(small)).toBe('export const a = 1;\n');
    expect(await readSourceCapped(big)).toBeNull();
    // The cap is a parameter, so a caller that can afford more can ask for more.
    expect(await readSourceCapped(big, Number.MAX_SAFE_INTEGER)).not.toBeNull();
  });

  it('returns null for a missing path and for a directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ol-scan-miss-'));
    mkdirSync(join(dir, 'subdir'));
    expect(await readSourceCapped(join(dir, 'nope.ts'))).toBeNull();
    expect(await readSourceCapped(join(dir, 'subdir'))).toBeNull();
  });
});
