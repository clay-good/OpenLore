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
import { mkdtempSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from 'node:fs';
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

describe('mapFilesBounded — a failed scan stops, it does not run on unobserved', () => {
  it('starts no new work after the returned promise has rejected', async () => {
    // `Promise.all(paths.map(fn))` cannot start work after a rejection — every call was issued
    // before the first rejection could be observed. A worker pool can, and if it does, the
    // caller's next scan runs alongside an abandoned one and the documented peak is breached.
    const paths = Array.from({ length: 200 }, (_, i) => `f${i}.ts`);
    let started = 0;
    let rejected = false;
    const startedAfterRejection: number[] = [];

    await expect(
      mapFilesBounded(paths, async (_p, i) => {
        started++;
        if (rejected) startedAfterRejection.push(i);
        await tick(1);
        if (i === 0) throw new Error('boom');
        return i;
      }, 4),
    ).rejects.toThrow('boom');
    rejected = true;

    const startedAtRejection = started;
    await tick(80); // plenty of time for an abandoned pool to drain the remaining 190+ paths

    expect(startedAfterRejection, 'work was started after the caller gave up').toEqual([]);
    expect(started, 'the pool kept draining the cursor after rejecting').toBe(startedAtRejection);
    expect(started).toBeLessThan(paths.length);
  });

  it('an abandoned pool cannot keep scanning the repository behind the next one', async () => {
    // This is the shape `analyze` actually runs: scans back to back, and MCP handlers that
    // swallow the rejection. When scan A rejects, its already-awaiting workers necessarily
    // finish their CURRENT file — `Promise.all` has that same straggler property — so a brief
    // overlap bounded by the width is expected and fine. What must NOT happen is scan A's pool
    // continuing to pull new files while scan B runs: that is unbounded in the repository's
    // size, and it is what breaches the peak this module promises.
    const WIDTH = 8;
    const paths = Array.from({ length: 400 }, (_, i) => `f${i}.ts`);
    let aStarted = 0;
    let inFlight = 0;
    let peak = 0;
    const track = async <T,>(work: () => Promise<T>): Promise<T> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try { return await work(); } finally { inFlight--; }
    };

    await mapFilesBounded(paths, (_p, i) => track(async () => {
      aStarted++;
      await tick(1);
      if (i === 0) throw new Error('scan A fails');
      return i;
    }), WIDTH).catch(() => { /* the caller swallows it, as MCP handlers do */ });

    await mapFilesBounded(paths, () => track(async () => { await tick(1); return 1; }), WIDTH);

    // Scan A touched roughly one wave, not the whole 400-file repository.
    expect(aStarted, 'the abandoned pool kept scanning').toBeLessThanOrEqual(WIDTH * 2);
    // Overlap is bounded by stragglers, never by the repository.
    expect(peak, `peak ${peak} exceeds one width of stragglers plus a full scan`)
      .toBeLessThanOrEqual(WIDTH * 2);
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

  it('reads no more than the size it checked, even if the file grows mid-read', async () => {
    // THE cap's soundness property. `handle.readFile()` reads to CURRENT end-of-file, so sizing
    // and reading one handle is NOT sufficient on its own: a file appended to during the await
    // window comes back in full, straight through the cap. Measured before the fix: a 1 KB file
    // that grew to 20 MB returned 20 MB. The read must be bounded to the size that was checked.
    dir = mkdtempSync(join(tmpdir(), 'ol-scan-grow-'));
    const p = join(dir, 'grows.ts');
    const original = 'a'.repeat(1024);

    // Race the append against the scan repeatedly. Whether it lands before the `stat` or between
    // the `stat` and the read is timing-dependent, so BOTH correct outcomes are accepted — the
    // file was already oversized when measured (`null`), or it was measured small and read at
    // exactly that size. The buggy outcome — returning the GROWN contents through the cap — is
    // excluded either way, so this cannot flake into a false pass or a false failure.
    for (let attempt = 0; attempt < 25; attempt++) {
      writeFileSync(p, original);
      const pending = readSourceCapped(p);
      appendFileSync(p, 'b'.repeat(8 * 1024 * 1024));
      const out = await pending;

      if (out !== null) {
        expect(out, `attempt ${attempt}: read past the size it checked`).toBe(original);
      }
      expect(
        out === null || out.length <= SOURCE_SCAN_MAX_FILE_BYTES,
        `attempt ${attempt}: returned ${out?.length} bytes through a ${SOURCE_SCAN_MAX_FILE_BYTES}-byte cap`,
      ).toBe(true);
    }
  });

  it('returns the whole file for the ordinary case where nothing is writing', async () => {
    // The bounded read must not truncate a file that is simply sitting there — including one
    // whose byte length differs from its character length.
    dir = mkdtempSync(join(tmpdir(), 'ol-scan-exact-'));
    const p = join(dir, 'unicode.ts');
    const body = `export const s = "${'héllo — wörld ✅'.repeat(500)}";\n`;
    writeFileSync(p, body, 'utf-8');
    expect(await readSourceCapped(p)).toBe(body);
  });

  it('returns null for a missing path and for a directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ol-scan-miss-'));
    mkdirSync(join(dir, 'subdir'));
    expect(await readSourceCapped(join(dir, 'nope.ts'))).toBeNull();
    expect(await readSourceCapped(join(dir, 'subdir'))).toBeNull();
  });
});
