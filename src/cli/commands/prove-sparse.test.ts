import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  readCachedContext: vi.fn(),
  close: vi.fn(),
  open: vi.fn(),
}));

vi.mock('../../core/services/mcp-handlers/utils.js', () => ({ readCachedContext: mocks.readCachedContext }));
vi.mock('../../core/services/edge-store.js', () => ({
  EdgeStore: {
    exists: () => true,
    dbPath: () => '/repo/.openlore/analysis/call-graph.db',
    open: mocks.open,
  },
}));

import { runProve } from './prove.js';

describe('prove sparse-graph refusal wiring', () => {
  it('uses persisted distinct caller fan-in instead of duplicate raw call edges', async () => {
    mocks.open.mockReturnValue({
      notReady: null,
      close: mocks.close,
      countNodesWithMinFanIn: () => 0,
    });
    mocks.readCachedContext.mockResolvedValue({
      edgeStore: {
        getAllInternalNodes: () => [{ id: 'src/a.ts::leaf', name: 'leaf', filePath: 'src/a.ts' }],
        getCallers: () => [
          { callerId: 'src/a.ts::caller' },
          { callerId: 'src/a.ts::caller' },
        ],
        getCallees: () => [],
        getNode: () => ({ name: 'caller', isExternal: false }),
      },
    });

    const result = await runProve({
      directory: '/repo',
      runs: 1,
      model: 'sonnet',
      maxBudgetUsd: 0.5,
      dryRun: false,
      estimate: true,
      generatedAt: '2026-08-09T00:00:00.000Z',
      repoSha: null,
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('0 functions have ≥2 callers');
    expect(result.message).toContain('at least 1 is required');
    expect(result.message).toContain('Nothing is wrong with the installation');
    expect(mocks.readCachedContext).not.toHaveBeenCalled();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it('returns retry guidance when the graph store cannot be opened', async () => {
    mocks.open.mockImplementation(() => { throw new Error('database is locked'); });

    const result = await runProve({
      directory: '/repo',
      runs: 1,
      model: 'sonnet',
      maxBudgetUsd: 0.5,
      dryRun: false,
      estimate: true,
      generatedAt: '2026-08-09T00:00:00.000Z',
      repoSha: null,
    });

    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('Retry after any running "openlore analyze" completes'),
    });
  });
});
