/**
 * Off-heap hand-off for the CFG/def-use overlay (issue #304).
 *
 * The overlay is pure write-through — built, persisted to `cfg_overlay`, then stripped — so it is
 * spilled to a file as each file is merged rather than accumulated for the whole repository. These
 * cover the properties the graph write depends on: what goes in comes back out, in order, byte for
 * byte, with framing that a repository-controlled path cannot break; and a spill that fails is
 * inert rather than destructive.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CfgSpill, _setDrainChunkBytesForTesting } from './cfg-spill.js';
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

describe('CfgSpill — round-trip', () => {
  it('returns every row, in write order, with the CFG byte-identical to JSON.stringify', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ol-cfgspill-'));
    const spill = await CfgSpill.open(dir);
    expect(spill).not.toBeNull();

    const a = cfg('alpha'), b = cfg('beta'), c = cfg('gamma');
    spill!.write('src/one.ts', [['src/one.ts::a', a], ['src/one.ts::b', b]]);
    spill!.write('src/two.ts', [['src/two.ts::c', c]]);
    await spill!.finish();

    const rows = await drainAll(spill!);
    expect(rows.map(r => r.functionId)).toEqual(['src/one.ts::a', 'src/one.ts::b', 'src/two.ts::c']);
    expect(rows.map(r => r.filePath)).toEqual(['src/one.ts', 'src/one.ts', 'src/two.ts']);
    // The stored form must be exactly what the table would have held, so the drain can bind it
    // straight in without a parse/re-stringify that could alter the persisted bytes.
    expect(rows.map(r => r.cfgJson)).toEqual([a, b, c].map(x => JSON.stringify(x)));
    expect(spill!.count).toBe(3);
    await spill!.dispose();
  });

  it('reassembles rows that straddle the read chunks', async () => {
    // The spill must be LARGER than one drain chunk, or the partial-line carry — the only tricky
    // part of the reader — is never exercised. A first draft used 5,000 small rows against the
    // 4 MB production chunk (1.13 MB total) and a mutation that dropped the carry entirely still
    // passed. Shrinking the chunk crosses it many times over for a fraction of the I/O.
    dir = mkdtempSync(join(tmpdir(), 'ol-cfgspill-many-'));
    const restoreChunk = _setDrainChunkBytesForTesting(1024);
    try {
      const spill = await CfgSpill.open(dir);
      const n = 200;
      for (let i = 0; i < n; i++) spill!.write(`src/f${i}.ts`, [[`src/f${i}.ts::fn${i}`, cfg(`v${i}`)]]);
      await spill!.finish();
      expect(statSync(spill!.path).size, 'fixture must span many drain chunks')
        .toBeGreaterThan(1024 * 8);

      const rows = await drainAll(spill!);
      expect(rows).toHaveLength(n);
      expect(rows[0].functionId).toBe('src/f0.ts::fn0');
      expect(rows[n - 1].functionId).toBe(`src/f${n - 1}.ts::fn${n - 1}`);
      // No row may be dropped, duplicated, or corrupted by a chunk boundary.
      expect(new Set(rows.map(r => r.functionId)).size).toBe(n);
      for (const [i, row] of rows.entries()) {
        expect(row.cfgJson, `row ${i} corrupted at a chunk boundary`).toBe(JSON.stringify(cfg(`v${i}`)));
      }
      await spill!.dispose();
    } finally {
      _setDrainChunkBytesForTesting(restoreChunk);
    }
  });

  it('cannot have its framing broken by a repository-controlled path', async () => {
    // Paths and ids come from the analyzed repository. A tab would split a field and a newline
    // would forge a row if either were written raw; both are JSON-escaped by construction.
    dir = mkdtempSync(join(tmpdir(), 'ol-cfgspill-evil-'));
    const spill = await CfgSpill.open(dir);
    const evilPath = 'src/we\tird\nfile".ts';
    const evilId = `${evilPath}::fn\t\n"x`;
    spill!.write(evilPath, [[evilId, cfg('v')]]);
    await spill!.finish();

    const rows = await drainAll(spill!);
    expect(rows).toHaveLength(1);
    expect(rows[0].filePath).toBe(evilPath);
    expect(rows[0].functionId).toBe(evilId);
    await spill!.dispose();
  });

  it('handles an empty spill without producing rows', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ol-cfgspill-empty-'));
    const spill = await CfgSpill.open(dir);
    await spill!.finish();
    expect(await drainAll(spill!)).toEqual([]);
    await spill!.dispose();
  });
});

describe('CfgSpill — failure is inert, never destructive', () => {
  it('returns null rather than throwing when the directory cannot be written', async () => {
    // A read-only or missing output directory must fall back to the in-memory path, not fail the
    // analysis: the overlay is an optional precision refinement.
    expect(await CfgSpill.open(join(tmpdir(), 'ol-definitely-does-not-exist-2f9c1', 'nested'))).toBeNull();
  });

  it('removes its file on dispose, and dispose is idempotent', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ol-cfgspill-dispose-'));
    const spill = await CfgSpill.open(dir);
    spill!.write('a.ts', [['a.ts::f', cfg('v')]]);
    await spill!.finish();
    expect(existsSync(spill!.path)).toBe(true);

    await spill!.dispose();
    expect(existsSync(spill!.path)).toBe(false);
    await expect(spill!.dispose()).resolves.toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('drops an unserializable overlay instead of throwing', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ol-cfgspill-circular-'));
    const spill = await CfgSpill.open(dir);
    const circular = cfg('v') as unknown as Record<string, unknown>;
    circular.self = circular;
    spill!.write('a.ts', [['a.ts::bad', circular as unknown as FunctionCfg], ['a.ts::good', cfg('ok')]]);
    await spill!.finish();

    const rows = await drainAll(spill!);
    expect(rows.map(r => r.functionId)).toEqual(['a.ts::good']);
    await spill!.dispose();
  });
});
