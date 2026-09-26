/**
 * Spec-22 — get_change_coupling handler over a mocked change-coupling snapshot.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (d: string) => d),
  readCachedContext: vi.fn(),
  // The no-index verdict the real diagnosis returns when nothing is on disk.
  diagnoseIndexUnservable: vi.fn(async () => ({ error: 'No analysis found. Run analyze_codebase first.', notReady: true, reason: 'index-absent', remedy: 'openlore analyze' })),
}));

import { handleGetChangeCoupling } from './change-coupling.js';
import { readCachedContext } from './utils.js';

const RECORDS = [
  { filePath: 'src/a.ts', churn: 14, coupledWith: [{ file: 'src/b.ts', support: 8, confidence: 0.9 }] },
  { filePath: 'src/b.ts', churn: 6, coupledWith: [{ file: 'src/a.ts', support: 8, confidence: 0.8 }] },
];

function mockStore(over: Record<string, unknown> = {}) {
  vi.mocked(readCachedContext).mockResolvedValue({
    edgeStore: {
      countChangeCoupling: () => RECORDS.length,
      getChangeCouplingForFiles: (files: string[]) => RECORDS.filter(r => files.some(f => f.endsWith(r.filePath))),
      getTopVolatile: (n: number) => [...RECORDS].sort((a, b) => b.churn - a.churn).slice(0, n),
      ...over,
    },
  } as never);
}

describe('handleGetChangeCoupling', () => {
  beforeEach(() => mockStore());

  it('returns a file\'s coupling + volatility (high churn → high)', async () => {
    const r = await handleGetChangeCoupling({ directory: '/p', file: 'src/a.ts' }) as {
      file: string; volatility: { level: string; changes: number };
      frequentlyChangesWith: Array<{ file: string; confidence: number }>;
      soundness: { posture: string; caveats: string[] };
    };
    expect(r.file).toBe('src/a.ts');
    expect(r.volatility).toEqual({ level: 'high', changes: 14 });
    expect(r.frequentlyChangesWith[0]).toMatchObject({ file: 'src/b.ts', confidence: 0.9 });
    expect(r.soundness.posture).toBe('advisory-signal');
    expect(r.soundness.caveats.join(' ')).toMatch(/correlation, not causation/i);
  });

  it('returns the most-volatile overview when no file is given', async () => {
    const r = await handleGetChangeCoupling({ directory: '/p' }) as {
      mostVolatile: Array<{ file: string; volatility: { level: string; changes: number } }>;
    };
    expect(r.mostVolatile[0]).toMatchObject({ file: 'src/a.ts', volatility: { level: 'high', changes: 14 } });
    expect(r.mostVolatile.map(m => m.file)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('messages clearly when there is no coupling data', async () => {
    mockStore({ countChangeCoupling: () => 0 });
    const r = await handleGetChangeCoupling({ directory: '/p' }) as { message: string };
    expect(r.message).toMatch(/no change-coupling data|re-run analyze/i);
  });

  it('messages when a file has no record', async () => {
    const r = await handleGetChangeCoupling({ directory: '/p', file: 'src/unknown.ts' }) as { message?: string; file?: string };
    expect(r.file).toBe('src/unknown.ts');
    expect(r.message).toMatch(/no change-coupling record/i);
  });

  it('errors cleanly without a cached graph', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce(null as never);
    const r = await handleGetChangeCoupling({ directory: '/p' }) as { error: string };
    expect(r.error).toMatch(/analyze_codebase/);
  });
});
