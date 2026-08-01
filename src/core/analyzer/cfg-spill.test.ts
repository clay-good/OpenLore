/**
 * Off-heap hand-off for the CFG/def-use overlay (issue #304), with an in-memory fast path (#306).
 *
 * The overlay is pure write-through — built, persisted to `cfg_overlay`, then stripped — so it is
 * buffered until the graph write and drained then. On a repository whose overlay fits the threshold
 * it never leaves memory and no file is touched (#306); past the threshold it overflows to a file
 * and streams back (#304's bound). These cover the properties the graph write depends on: what goes
 * in comes back out, in order, byte for byte, on EITHER path; framing a repository-controlled path
 * cannot break; the common case creates no file; the overflow is attempted at most once; and a
 * spill that fails is inert rather than destructive.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import {
  CfgSpill,
  CFG_SPILL_PREFIX,
  sweepLeakedCfgSpills,
  _setDrainChunkBytesForTesting,
  _setOverflowThresholdBytesForTesting,
} from './cfg-spill.js';
import type { FunctionCfg } from './cfg.js';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const cfg = (variable: string): FunctionCfg => ({
  blocks: [{ id: 0, kind: 'entry' }, { id: 1, kind: 'exit' }],
  edges: [{ from: 0, to: 1, kind: 'normal' }],
  defUse: [{ variable, defLine: 1, useLine: 2, precision: 'exact' }],
  params: [variable],
  paramLine: 1,
});

async function drainAll(spill: CfgSpill): Promise<Array<{ functionId: string; filePath: string; cfgJson: string }>> {
  const out = [];
  for await (const row of spill.drain()) out.push(row);
  return out;
}

/** Force the on-disk path for a fixture that is too small to cross the real threshold. */
async function withOverflowThreshold<T>(bytes: number, fn: () => Promise<T>): Promise<T> {
  const restore = _setOverflowThresholdBytesForTesting(bytes);
  try {
    return await fn();
  } finally {
    _setOverflowThresholdBytesForTesting(restore);
  }
}

describe('CfgSpill — round-trip is byte-identical on both the in-memory and the overflow path', () => {
  // The same fixture, drained from memory and from a file, must yield identical rows — that
  // equivalence is what lets the graph write bind either straight into `cfg_overlay`.
  for (const [label, thresholdBytes] of [['in memory', Number.MAX_SAFE_INTEGER], ['overflowed to disk', 0]] as const) {
    it(`returns every row in write order with the CFG byte-identical to JSON.stringify — ${label}`, async () => {
      dir = mkdtempSync(join(tmpdir(), 'ol-cfgspill-'));
      const rows = await withOverflowThreshold(thresholdBytes, async () => {
        const spill = await CfgSpill.open(dir!);
        const a = cfg('alpha'), b = cfg('beta'), c = cfg('gamma');
        spill.write('src/one.ts', [['src/one.ts::a', a], ['src/one.ts::b', b]]);
        spill.write('src/two.ts', [['src/two.ts::c', c]]);
        await spill.finish();

        const drained = await drainAll(spill);
        expect(drained.map(r => r.functionId)).toEqual(['src/one.ts::a', 'src/one.ts::b', 'src/two.ts::c']);
        expect(drained.map(r => r.filePath)).toEqual(['src/one.ts', 'src/one.ts', 'src/two.ts']);
        // The stored form must be exactly what the table would have held, so the drain can bind it
        // straight in without a parse/re-stringify that could alter the persisted bytes.
        expect(drained.map(r => r.cfgJson)).toEqual([a, b, c].map(x => JSON.stringify(x)));
        expect(spill.count).toBe(3);
        // Only the overflow path is allowed to leave a file behind for the drain to read.
        expect(existsSync(spill.path)).toBe(label === 'overflowed to disk');
        await spill.dispose();
        return drained;
      });
      expect(rows).toHaveLength(3);
    });
  }

  it('creates no spill file for an overlay that fits the threshold', async () => {
    // The whole point of #306: a repository whose overlay is small pays no disk round-trip. The
    // real threshold (64 MB) dwarfs this fixture, so nothing may be written under the output dir.
    dir = mkdtempSync(join(tmpdir(), 'ol-cfgspill-nofile-'));
    const spill = await CfgSpill.open(dir);
    for (let i = 0; i < 50; i++) spill.write(`src/f${i}.ts`, [[`src/f${i}.ts::fn${i}`, cfg(`v${i}`)]]);
    await spill.finish();
    expect(readdirSync(dir), 'a below-threshold overlay must never touch the disk').toEqual([]);

    // ...and it is still fully drainable from memory.
    const rows = await drainAll(spill);
    expect(rows).toHaveLength(50);
    expect(rows[49].functionId).toBe('src/f49.ts::fn49');
    await spill.dispose();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('reassembles rows that straddle the read chunks once overflowed', async () => {
    // The spill must be LARGER than one drain chunk, or the partial-line carry — the only tricky
    // part of the reader — is never exercised. Lower the overflow threshold to 0 so every write
    // goes to disk, and shrink the drain chunk so the fixture crosses it many times over.
    dir = mkdtempSync(join(tmpdir(), 'ol-cfgspill-many-'));
    const restoreChunk = _setDrainChunkBytesForTesting(1024);
    const restoreThreshold = _setOverflowThresholdBytesForTesting(0);
    try {
      const spill = await CfgSpill.open(dir);
      const n = 200;
      for (let i = 0; i < n; i++) spill.write(`src/f${i}.ts`, [[`src/f${i}.ts::fn${i}`, cfg(`v${i}`)]]);
      await spill.finish();
      expect(statSync(spill.path).size, 'fixture must span many drain chunks')
        .toBeGreaterThan(1024 * 8);

      const rows = await drainAll(spill);
      expect(rows).toHaveLength(n);
      expect(rows[0].functionId).toBe('src/f0.ts::fn0');
      expect(rows[n - 1].functionId).toBe(`src/f${n - 1}.ts::fn${n - 1}`);
      // No row may be dropped, duplicated, or corrupted by a chunk boundary.
      expect(new Set(rows.map(r => r.functionId)).size).toBe(n);
      for (const [i, row] of rows.entries()) {
        expect(row.cfgJson, `row ${i} corrupted at a chunk boundary`).toBe(JSON.stringify(cfg(`v${i}`)));
      }
      await spill.dispose();
    } finally {
      _setDrainChunkBytesForTesting(restoreChunk);
      _setOverflowThresholdBytesForTesting(restoreThreshold);
    }
  });

  it('overflows exactly once, mid-stream, keeping every row across the boundary', async () => {
    // Rows written before the threshold live in memory; the write that crosses it moves them to the
    // file and the rest stream there. Neither the pre-overflow nor the post-overflow rows may be
    // lost, and the order must be preserved across the hand-off.
    dir = mkdtempSync(join(tmpdir(), 'ol-cfgspill-cross-'));
    // One row is ~110 bytes framed; a 400-byte threshold trips after a handful, mid-stream.
    const rows = await withOverflowThreshold(400, async () => {
      const spill = await CfgSpill.open(dir!);
      const n = 40;
      for (let i = 0; i < n; i++) spill.write(`src/f${i}.ts`, [[`src/f${i}.ts::fn${i}`, cfg(`v${i}`)]]);
      await spill.finish();
      expect(existsSync(spill.path), 'crossing the threshold must have created the file').toBe(true);
      const drained = await drainAll(spill);
      await spill.dispose();
      return drained;
    });
    expect(rows.map(r => r.functionId)).toEqual(
      Array.from({ length: 40 }, (_, i) => `src/f${i}.ts::fn${i}`),
    );
  });

  it('cannot have its framing broken by a repository-controlled path', async () => {
    // Paths and ids come from the analyzed repository. A tab would split a field and a newline
    // would forge a row if either were written raw; both are JSON-escaped by construction. Checked
    // on the on-disk path, where a raw newline would be most dangerous.
    dir = mkdtempSync(join(tmpdir(), 'ol-cfgspill-evil-'));
    const rows = await withOverflowThreshold(0, async () => {
      const spill = await CfgSpill.open(dir!);
      const evilPath = 'src/we\tird\nfile".ts';
      const evilId = `${evilPath}::fn\t\n"x`;
      spill.write(evilPath, [[evilId, cfg('v')]]);
      await spill.finish();
      const drained = await drainAll(spill);
      await spill.dispose();
      return drained;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].filePath).toBe('src/we\tird\nfile".ts');
    expect(rows[0].functionId).toBe('src/we\tird\nfile".ts::fn\t\n"x');
  });

  it('handles an empty spill without producing rows or a file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ol-cfgspill-empty-'));
    const spill = await CfgSpill.open(dir);
    await spill.finish();
    expect(await drainAll(spill)).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    await spill.dispose();
  });
});

describe('CfgSpill — leaked files are swept, live ones are not', () => {
  it('removes a spill whose owning process is gone', async () => {
    // A build killed mid-flight (OOM-kill, Ctrl-C) leaves its spill behind, holding the entire
    // overlay. Nothing else would ever remove it, and the bundle exporter reads this directory.
    dir = mkdtempSync(join(tmpdir(), 'ol-cfgspill-sweep-'));
    // pid 999999 is above the default pid_max on macOS/Linux, so it cannot be running.
    const orphan = join(dir, `${CFG_SPILL_PREFIX}999999.ndjson`);
    writeFileSync(orphan, 'garbage\n');
    await sweepLeakedCfgSpills(dir);
    expect(existsSync(orphan)).toBe(false);
  });

  it('leaves a spill belonging to ANOTHER live process alone', async () => {
    // A concurrent analysis owns its spill until it finishes, and a build on a large repository
    // can legitimately run for hours — so liveness, not age, is what decides.
    //
    // The pid must be a real OTHER process. Using `process.pid` only exercises the "don't delete
    // your own" branch, which is a separate early return — a first draft did that and a mutation
    // removing the liveness check entirely still passed.
    dir = mkdtempSync(join(tmpdir(), 'ol-cfgspill-live-'));
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      await new Promise<void>(r => child.once('spawn', () => r()));
      const other = join(dir, `${CFG_SPILL_PREFIX}${child.pid}.ndjson`);
      writeFileSync(other, 'another build\'s\n');
      await sweepLeakedCfgSpills(dir);
      expect(existsSync(other), "the sweep deleted a live build's spill").toBe(true);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('leaves unrelated files alone and never throws on a missing directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ol-cfgspill-other-'));
    const keep = join(dir, 'llm-context.json');
    writeFileSync(keep, '{}');
    await sweepLeakedCfgSpills(dir);
    expect(existsSync(keep)).toBe(true);
    await expect(sweepLeakedCfgSpills(join(dir, 'nope'))).resolves.toBeUndefined();
  });
});

describe('CfgSpill — failure is inert, never destructive', () => {
  it('degrades to a disclosed empty overlay when the overflow file cannot be opened', async () => {
    // A read-only or missing output directory only matters once the overlay overflows: below the
    // threshold it never touches the disk. When overflow does fail, the spill must latch `failed`
    // so the consumer skips it, and must not throw — the overlay is an optional precision
    // refinement, never a reason to fail the analysis.
    const missing = join(tmpdir(), 'ol-definitely-does-not-exist-2f9c1', 'nested');
    await withOverflowThreshold(0, async () => {
      const spill = await CfgSpill.open(missing);
      expect(() => spill.write('a.ts', [['a.ts::f', cfg('v')]])).not.toThrow();
      expect(spill.failed).toBe(true);
      await spill.finish();
      expect(await drainAll(spill)).toEqual([]);
      await spill.dispose();
    });
  });

  it('attempts the overflow at most once and never retries per write', async () => {
    // A failed overflow that retried on every subsequent write reopened and rewrote the whole
    // buffer per function — measured 5× slower on a large repository (#306). Once failed it must
    // stay failed: count the open attempts by watching the failed latch never reset.
    const missing = join(tmpdir(), 'ol-cfgspill-noretry-2f9c1', 'nested');
    await withOverflowThreshold(0, async () => {
      const spill = await CfgSpill.open(missing);
      spill.write('a.ts', [['a.ts::f0', cfg('v0')]]);
      expect(spill.failed).toBe(true);
      expect(spill.count).toBe(1); // the row that tripped the failed overflow was still counted
      // Many further writes must remain inert — none may reopen the file or accumulate rows.
      for (let i = 1; i < 500; i++) spill.write(`a.ts`, [[`a.ts::f${i}`, cfg(`v${i}`)]]);
      expect(spill.failed).toBe(true);
      // If a failed spill kept accepting rows, `count` would have climbed to 500 — the early
      // return that makes the overflow attempt at-most-once is what keeps it at 1.
      expect(spill.count).toBe(1);
      await spill.finish();
      expect(await drainAll(spill)).toEqual([]);
      await spill.dispose();
    });
  });

  it('removes its file on dispose, and dispose is idempotent', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ol-cfgspill-dispose-'));
    const path = await withOverflowThreshold(0, async () => {
      const spill = await CfgSpill.open(dir!);
      spill.write('a.ts', [['a.ts::f', cfg('v')]]);
      await spill.finish();
      expect(existsSync(spill.path)).toBe(true);

      await spill.dispose();
      expect(existsSync(spill.path)).toBe(false);
      await expect(spill.dispose()).resolves.toBeUndefined();
      return spill.path;
    });
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('drops an unserializable overlay instead of throwing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ol-cfgspill-circular-'));
    const spill = await CfgSpill.open(dir);
    const circular = cfg('v') as unknown as Record<string, unknown>;
    circular.self = circular;
    spill.write('a.ts', [['a.ts::bad', circular as unknown as FunctionCfg], ['a.ts::good', cfg('ok')]]);
    await spill.finish();

    const rows = await drainAll(spill);
    expect(rows.map(r => r.functionId)).toEqual(['a.ts::good']);
    await spill.dispose();
  });
});
